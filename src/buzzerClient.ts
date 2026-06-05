/**
 * One buzzer client lifecycle, run inside its own browser context:
 *
 *   load -> complete lead gate -> enter team name -> click BUZZ -> observe outcome
 *
 * Every interactive step rides the Blazor Server circuit over `/_blazor`. If that
 * circuit can't establish (the App Runner multi-instance affinity bug), the inputs
 * and the BUZZ click do nothing, and we record where it got stuck plus the circuit
 * signals captured by instrument.ts.
 */

import type { Browser, BrowserContext } from "playwright";
import { devices } from "playwright";
import {
  buzzerEmail,
  buzzerName,
  BUZZER_URL,
  REBUZZ_INTERVAL_MS,
  SOAK_SECONDS,
  TIMEOUTS,
} from "./config.js";
import {
  instrument,
  waitForCircuit,
  watchReconnectModal,
  type CircuitSignals,
} from "./instrument.js";

export type BuzzOutcome =
  | "success" // success status appeared
  | "error-status" // app showed an error status (e.g. NR ingest failed) — circuit worked
  | "circuit-not-connected" // transport never connected (the multi-instance /_blazor failure)
  | "lead-gate-stuck" // circuit connected but lead gate never cleared
  | "timeout" // reached buzzer but BUZZ produced no status
  | "load-failed"; // page never loaded

export interface BuzzerResult {
  index: number;
  outcome: BuzzOutcome;
  /** Stage reached: load | circuit | lead-gate | buzzer | done | soak */
  stage: string;
  durationMs: number;
  error?: string;
  signals: CircuitSignals;
  /** Soak only: total re-buzzes attempted while holding the circuit open. */
  soakBuzzes?: number;
  /** Soak only: re-buzzes that did NOT get a success status (dropped/404'd). */
  soakBuzzFailures?: number;
}

const mobile = devices["Pixel 7"];

/** Pause between lead-gate field fills so each oninput value reaches the server. */
const LEAD_FIELD_SETTLE_MS = 150;

export async function runBuzzerClient(
  browser: Browser,
  index: number,
): Promise<BuzzerResult> {
  const start = Date.now();
  const name = buzzerName(index);
  let context: BrowserContext | undefined;
  let stage = "load";

  // Default signals so a load failure still returns a well-formed result.
  let signals: CircuitSignals = {
    blazorHttp: [],
    blazorStatusHistogram: {},
    sawBlazorError: false,
    sawBlazor404: false,
    circuitConnected: false,
    sawBlazorNegotiate: false,
    webSocketOpened: false,
    webSocketFailed: false,
    sawReconnectModal: false,
    sawRejoinFailed: false,
    circuitConsoleErrors: [],
    consoleErrors: [],
  };

  let soakBuzzes = 0;
  let soakBuzzFailures = 0;

  const finish = (outcome: BuzzOutcome, error?: string): BuzzerResult => ({
    index,
    outcome,
    stage,
    durationMs: Date.now() - start,
    error,
    signals,
    ...(SOAK_SECONDS > 0 ? { soakBuzzes, soakBuzzFailures } : {}),
  });

  try {
    context = await browser.newContext({ ...mobile });
    const page = await context.newPage();
    signals = instrument(page);
    const stopModalWatch = watchReconnectModal(page, signals);

    try {
      await page.goto(BUZZER_URL, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUTS.pageLoad,
      });
    } catch (e) {
      stopModalWatch();
      return finish("load-failed", `goto failed: ${asMsg(e)}`);
    }

    // --- Readiness -----------------------------------------------------------
    // Two app shapes are supported:
    //  - Stateless buzzer (the fix): no /_blazor at all. Interactivity is plain JS,
    //    usable as soon as the form is in the DOM — proceed immediately.
    //  - Old Blazor Server app: every interaction rides the /_blazor circuit, which
    //    on App Runner falls back to long polling and takes seconds to connect;
    //    interacting before then drops events. Wait for the transport to connect.
    // We distinguish by whether the page negotiates a circuit within a short grace.
    stage = "circuit";
    await page
      .locator("#firstName")
      .waitFor({ state: "visible", timeout: TIMEOUTS.circuitReady })
      .catch(() => {});

    const graceEnd = Date.now() + 3000;
    while (Date.now() < graceEnd && !signals.sawBlazorNegotiate) {
      await page.waitForTimeout(150);
    }
    if (signals.sawBlazorNegotiate) {
      const connected = await waitForCircuit(page, signals, TIMEOUTS.circuitReady);
      if (!connected) {
        stopModalWatch();
        return finish("circuit-not-connected", "Blazor transport never connected");
      }
    }
    // else: stateless app — no circuit to wait for.

    // --- Lead gate -----------------------------------------------------------
    stage = "lead-gate";
    const leadFilled = await fillLeadGate(page, index).catch(() => false);
    if (!leadFilled) {
      stopModalWatch();
      return finish("lead-gate-stuck", "could not fill/submit lead gate");
    }

    // Continue To Buzzer -> the lead gate overlay disappears and #teamName is enabled.
    await page
      .getByRole("button", { name: /continue to buzzer/i })
      .click({ timeout: TIMEOUTS.uiStep })
      .catch(() => {
        /* tolerate; detected below */
      });

    const reachedBuzzer = await page
      .locator(".lead-gate")
      .waitFor({ state: "hidden", timeout: TIMEOUTS.uiStep })
      .then(() => true)
      .catch(() => false);

    if (!reachedBuzzer) {
      const diag = await diagnoseLeadGate(page).catch(() => "diag-failed");
      stopModalWatch();
      return finish("lead-gate-stuck", `lead gate did not clear after Continue | ${diag}`);
    }

    // --- Buzz ----------------------------------------------------------------
    stage = "buzzer";
    await page.fill("#teamName", name, { timeout: TIMEOUTS.uiStep }).catch(() => {});
    // teamName also binds on oninput — let it reach the server before BUZZ, or the
    // server-side handler sees an empty name and shows a validation error instead.
    await page.waitForTimeout(LEAD_FIELD_SETTLE_MS + 150);
    await page
      .locator("button.buzzer-button")
      .click({ timeout: TIMEOUTS.uiStep })
      .catch(() => {});

    // Success: p.status.ok containing "Buzz received for <name>".
    const ok = page.locator("p.status.ok", { hasText: `Buzz received for ${name}` });
    const err = page.locator("p.status.error");

    const outcome = await Promise.race([
      ok
        .waitFor({ state: "visible", timeout: TIMEOUTS.uiStep })
        .then<BuzzOutcome>(() => "success"),
      err
        .waitFor({ state: "visible", timeout: TIMEOUTS.uiStep })
        .then<BuzzOutcome>(() => "error-status"),
    ]).catch<BuzzOutcome>(() => "timeout");

    // --- Soak: hold the circuit open and keep buzzing ------------------------
    // This is what catches the App Runner scale-out 404: the circuit must still be
    // alive when a second instance comes up so its long poll gets re-routed there.
    // The 404 itself is recorded by instrument.ts (signals.sawBlazor404) regardless
    // of the per-buzz status below.
    if (SOAK_SECONDS > 0 && (outcome === "success" || outcome === "error-status")) {
      stage = "soak";
      const deadline = start + SOAK_SECONDS * 1000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(REBUZZ_INTERVAL_MS);
        soakBuzzes++;
        // Use a UNIQUE team name each round so the success status differs from the
        // previous one — otherwise the stale "Buzz received for <name>" message is
        // still on screen and every check passes trivially (false negatives).
        const rname = `${name}-r${soakBuzzes}`;
        const filled = await setTeamName(page, rname);
        await page
          .locator("button.buzzer-button")
          .click({ timeout: TIMEOUTS.uiStep })
          .catch(() => {});
        const rebuzzed =
          filled &&
          (await page
            .locator("p.status.ok", { hasText: `Buzz received for ${rname}` })
            .waitFor({ state: "visible", timeout: TIMEOUTS.uiStep })
            .then(() => true)
            .catch(() => false));
        if (!rebuzzed) soakBuzzFailures++;
      }
    }

    stage = stage === "soak" ? "soak" : "done";
    stopModalWatch();
    const errText =
      outcome === "error-status"
        ? await err.textContent().then((t) => t?.trim()).catch(() => undefined)
        : undefined;
    return finish(outcome, errText ?? undefined);
  } catch (e) {
    return finish("timeout", asMsg(e));
  } finally {
    await context?.close().catch(() => {});
  }
}

/** Sets #teamName (oninput-bound) and confirms the value stuck, a few attempts. */
async function setTeamName(
  page: import("playwright").Page,
  value: string,
): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await page.fill("#teamName", value, { timeout: TIMEOUTS.uiStep }).catch(() => {});
    await page.waitForTimeout(LEAD_FIELD_SETTLE_MS);
    if ((await page.inputValue("#teamName").catch(() => "")) === value) return true;
  }
  return false;
}

async function fillLeadGate(
  page: import("playwright").Page,
  index: number,
): Promise<boolean> {
  const email = buzzerEmail(index);
  const tag = buzzerName(index);
  const fields: Array<[string, string]> = [
    ["#firstName", `LOADTEST`],
    ["#lastName", tag],
    ["#businessEmail", email],
    ["#companyName", `LOADTEST Co ${index}`],
    ["#jobTitle", `Tester`],
    ["#country", `Testland`],
  ];
  return fillFieldsUntilStable(page, fields);
}

/**
 * Fills a set of server-bound (`@bind:event="oninput"`) inputs and re-fills until
 * they ALL read back correctly at once.
 *
 * Why a whole-form loop: the first interaction after the long-polling circuit
 * connects can land before the component finishes wiring its handlers, so that
 * field's oninput is dropped and the next interactive re-render resets it to the
 * server's empty value — *after* we've moved on to later fields. Re-filling the
 * whole form until everything is simultaneously stable closes that race. If it
 * never stabilizes (a genuinely dead circuit), we bail and the client is recorded
 * as stuck.
 */
async function fillFieldsUntilStable(
  page: import("playwright").Page,
  fields: Array<[string, string]>,
  rounds = 6,
): Promise<boolean> {
  for (let round = 0; round < rounds; round++) {
    for (const [sel, value] of fields) {
      await page.fill(sel, value, { timeout: TIMEOUTS.uiStep }).catch(() => {});
      await page.waitForTimeout(LEAD_FIELD_SETTLE_MS);
    }
    // Let any pending interactive re-render land, then check all values held.
    await page.waitForTimeout(400);
    const values = await Promise.all(
      fields.map(([sel]) => page.inputValue(sel).catch(() => "")),
    );
    if (values.every((v, i) => v === fields[i][1])) return true;
  }
  return false;
}

function asMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function diagnoseLeadGate(page: import("playwright").Page): Promise<string> {
  const leadErr = (await page.locator(".lead-error").first().textContent().catch(() => null))?.trim();
  const btnText = (await page
    .getByRole("button", { name: /continue|submitting/i })
    .first()
    .textContent()
    .catch(() => null))?.trim();
  const vals: Record<string, string> = {};
  for (const id of ["firstName", "businessEmail", "country"]) {
    vals[id] = await page.inputValue(`#${id}`).catch(() => "<none>");
  }
  return `leadError="${leadErr ?? ""}" btn="${btnText ?? "(gone)"}" vals=${JSON.stringify(vals)}`;
}
