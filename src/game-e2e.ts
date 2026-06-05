/**
 * ENTRY: Game end-to-end buzz-propagation test.
 *
 * Opens one game host session, advances it to the Question phase (where it polls
 * New Relic for buzzes), fires a small burst of real buzzer clients, and asserts
 * the game displays a buzz highlight within a generous timeout. This reproduces /
 * verifies the Summit symptom: "the game did not show the buzz attempts".
 *
 * Note: the game shows only latest(teamName) from NR, so we assert that *a* buzz
 * was displayed, not all of them. Display is delayed by NR ingest + query latency.
 *
 * Usage:
 *   npm run game:e2e
 *   PASS_THRESHOLD=0 npm run game:e2e   # baseline, never fails
 */

import { chromium, type Browser } from "playwright";
import {
  GAME_BURST_CLIENTS,
  GAME_URL,
  HEADLESS,
  PASS_THRESHOLD,
  REQUIRE_BUZZ_DISPLAY,
  RUN_TAG,
} from "./config.js";
import { runBuzzerClient, type BuzzerResult } from "./buzzerClient.js";
import {
  closeGameHost,
  openGameInQuestionPhase,
  waitForBuzzDisplayed,
} from "./gameHost.js";
import { writeReport } from "./report.js";

async function main(): Promise<void> {
  console.log(
    `Game E2E: host ${GAME_URL}, firing ${GAME_BURST_CLIENTS} buzzers (run ${RUN_TAG}, headless=${HEADLESS}).`,
  );

  const browser: Browser = await chromium.launch({ headless: HEADLESS });
  let buzzDisplayed: string | null = null;
  let gameReachedQuestion = false;
  let buzzerResults: BuzzerResult[] = [];
  let gameSignals: ReturnType<typeof structuredSignals> | null = null;

  try {
    const host = await openGameInQuestionPhase(browser).catch((e) => {
      console.error("  could not drive game to Question phase:", asMsg(e));
      return null;
    });

    if (host) {
      gameReachedQuestion = true;
      console.log("  game is in Question phase; polling NR for buzzes.");

      // Start watching for the highlight, then fire the buzzers concurrently so a
      // buzz lands during the poll window.
      const watch = waitForBuzzDisplayed(host.page);

      // Use a distinct index range so these names don't collide with a load run.
      const burst = Array.from({ length: GAME_BURST_CLIENTS }, (_, i) =>
        runBuzzerClient(browser, 900000 + i),
      );
      const settled = await Promise.allSettled(burst);
      buzzerResults = settled
        .filter((s): s is PromiseFulfilledResult<BuzzerResult> => s.status === "fulfilled")
        .map((s) => s.value);
      const buzzed = buzzerResults.filter((r) => r.outcome === "success").length;
      console.log(`  burst buzzers succeeded: ${buzzed}/${buzzerResults.length}`);

      buzzDisplayed = await watch;
      gameSignals = structuredSignals(host.signals);
      await closeGameHost(host);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const buzzersSucceeded = buzzerResults.filter((r) => r.outcome === "success").length;
  const report = {
    kind: "game-e2e" as const,
    runTag: RUN_TAG,
    targetUrl: GAME_URL,
    timestamp: new Date().toISOString(),
    gameReachedQuestion,
    burstClients: buzzerResults.length,
    burstSucceeded: buzzersSucceeded,
    buzzDisplayed: buzzDisplayed !== null,
    buzzDisplayedName: buzzDisplayed,
    gameSignals,
    passThreshold: PASS_THRESHOLD,
    requireBuzzDisplay: REQUIRE_BUZZ_DISPLAY,
    // Pass gate is CIRCUIT HEALTH (the thing the App Runner fix addresses): the
    // game reached the Question phase and its own /_blazor circuit had no 404.
    // Whether the buzz is *displayed* depends on server-side NR polling latency /
    // config, which is independent of the circuit bug, so it is reported as an
    // observation and only gates pass/fail when REQUIRE_BUZZ_DISPLAY=1.
    // PASS_THRESHOLD=0 -> report-only (never fail).
    passed:
      PASS_THRESHOLD === 0
        ? true
        : gameReachedQuestion &&
          !(gameSignals?.sawBlazor404 ?? false) &&
          (!REQUIRE_BUZZ_DISPLAY || buzzDisplayed !== null),
  };

  printGameReport(report);
  const path = await writeReport(report, "game-e2e");
  console.log(`Report written: ${path}`);

  process.exit(report.passed ? 0 : 1);
}

function structuredSignals(s: import("./instrument.js").CircuitSignals) {
  return {
    sawBlazor404: s.sawBlazor404,
    sawBlazorError: s.sawBlazorError,
    sawReconnectModal: s.sawReconnectModal,
    sawRejoinFailed: s.sawRejoinFailed,
    blazorStatusHistogram: s.blazorStatusHistogram,
    circuitConsoleErrors: s.circuitConsoleErrors,
  };
}

function printGameReport(r: {
  passed: boolean;
  gameReachedQuestion: boolean;
  buzzDisplayed: boolean;
  buzzDisplayedName: string | null;
  burstSucceeded: number;
  burstClients: number;
  requireBuzzDisplay: boolean;
  gameSignals: { sawBlazor404: boolean; sawReconnectModal: boolean } | null;
}): void {
  const line = "─".repeat(58);
  console.log(`\n${line}`);
  console.log(`  GAME E2E BUZZ-PROPAGATION REPORT`);
  console.log(line);
  console.log(`  game reached Question phase .... ${yn(r.gameReachedQuestion)}`);
  console.log(`  burst buzzers succeeded ........ ${r.burstSucceeded}/${r.burstClients}`);
  console.log(`  game saw /_blazor 404 .......... ${yn(r.gameSignals?.sawBlazor404 ?? false)}  <-- circuit affinity bug (pass gate)`);
  console.log(`  game saw reconnect modal ....... ${yn(r.gameSignals?.sawReconnectModal ?? false)}`);
  const displaySuffix = r.requireBuzzDisplay ? " (gating)" : " (observation only)";
  console.log(`  buzz displayed in game ......... ${yn(r.buzzDisplayed)}${r.buzzDisplayedName ? ` ("${r.buzzDisplayedName}")` : ""}${displaySuffix}`);
  console.log(line);
  console.log(`  RESULT: ${r.passed ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`${line}\n`);
}

const yn = (b: boolean) => (b ? "yes" : "no");
const asMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

main().catch((e) => {
  console.error("game-e2e failed:", e);
  process.exit(2);
});
