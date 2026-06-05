/**
 * Attaches listeners to a Playwright Page to capture the signals that reveal the
 * Blazor Server `/_blazor` circuit failure on AWS App Runner:
 *
 *  - HTTP responses on `/_blazor` (a 404 = SignalR "No Connection with that ID",
 *    i.e. the follow-up request landed on an instance that doesn't own the circuit)
 *  - WebSocket open / error on `/_blazor`
 *  - console errors / page errors mentioning blazor / circuit / reconnect
 *  - the Blazor reconnect modal becoming visible / reaching "Failed to rejoin"
 *
 * Everything is recorded on a plain object so the report can aggregate across clients.
 */

import type { Page } from "playwright";

export interface BlazorHttpEvent {
  url: string;
  method: string;
  status: number;
  at: number;
}

export interface CircuitSignals {
  /** Every `/_blazor` HTTP response observed. */
  blazorHttp: BlazorHttpEvent[];
  /** Status-code histogram for `/_blazor` HTTP responses. */
  blazorStatusHistogram: Record<string, number>;
  /** True if any `/_blazor` response had a non-OK status (not 200/101/204). */
  sawBlazorError: boolean;
  /** True if any `/_blazor` response was a 404 (the affinity signature). */
  sawBlazor404: boolean;
  /**
   * True once a transport is actually connected: a long-poll `GET /_blazor?id=...`
   * returned 200, or a WebSocket stayed open without erroring. This is what the
   * client waits for before interacting. On App Runner the WebSocket is 403'd and
   * this is satisfied by the long-polling fallback; under the multi-instance bug
   * the long-poll 404s and this never flips true.
   */
  circuitConnected: boolean;
  /** WebSocket opened on `/_blazor`. */
  webSocketOpened: boolean;
  /**
   * WebSocket on `/_blazor` errored/closed. NOTE: on App Runner this is EXPECTED
   * (the proxy blocks WS with 403) and is not itself a failure — interactivity
   * works over the long-polling fallback. Recorded for visibility only; pass/fail
   * keys off circuitConnected + the long-poll 404, not this.
   */
  webSocketFailed: boolean;
  /** Reconnect modal became visible at any point. */
  sawReconnectModal: boolean;
  /** Reconnect modal reached the terminal "Failed to rejoin" state. */
  sawRejoinFailed: boolean;
  /** Console errors / page errors flagged as circuit-related. */
  circuitConsoleErrors: string[];
  /** All console errors / page errors (capped). */
  consoleErrors: string[];
}

const OK_STATUSES = new Set([200, 101, 204]);
const CIRCUIT_HINT = /(blazor|circuit|reconnect|signalr|websocket|_blazor)/i;
const MAX_CONSOLE = 50;

function isBlazorUrl(url: string): boolean {
  return url.includes("/_blazor");
}

export function instrument(page: Page): CircuitSignals {
  const signals: CircuitSignals = {
    blazorHttp: [],
    blazorStatusHistogram: {},
    sawBlazorError: false,
    sawBlazor404: false,
    circuitConnected: false,
    webSocketOpened: false,
    webSocketFailed: false,
    sawReconnectModal: false,
    sawRejoinFailed: false,
    circuitConsoleErrors: [],
    consoleErrors: [],
  };

  page.on("response", (res) => {
    const url = res.url();
    if (!isBlazorUrl(url)) return;
    const status = res.status();
    signals.blazorHttp.push({
      url,
      method: res.request().method(),
      status,
      at: Date.now(),
    });
    const key = String(status);
    signals.blazorStatusHistogram[key] = (signals.blazorStatusHistogram[key] ?? 0) + 1;
    if (!OK_STATUSES.has(status)) signals.sawBlazorError = true;
    if (status === 404) signals.sawBlazor404 = true;
    // A 200 on a transport request (`/_blazor?id=...`) — not negotiate/initializers —
    // means a long-polling (or WS) connection is established and the circuit is live.
    if (status === 200 && /\/_blazor\?id=/.test(url)) signals.circuitConnected = true;
  });

  // requestfailed catches the WebSocket upgrade GET /_blazor being rejected/aborted,
  // which on App Runner can manifest instead of a clean 404.
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (!isBlazorUrl(url)) return;
    signals.sawBlazorError = true;
    const failure = req.failure()?.errorText ?? "request failed";
    pushCapped(signals.consoleErrors, `requestfailed ${url}: ${failure}`);
    pushCapped(signals.circuitConsoleErrors, `requestfailed ${url}: ${failure}`);
  });

  page.on("websocket", (ws) => {
    if (!isBlazorUrl(ws.url())) return;
    signals.webSocketOpened = true;
    let errored = false;
    ws.on("socketerror", () => {
      errored = true;
      signals.webSocketFailed = true;
    });
    ws.on("close", () => {
      // A close during the short test window means the circuit didn't hold.
      signals.webSocketFailed = true;
    });
    // If the WS is still open after a grace period, treat the circuit as connected
    // (covers a post-fix environment where WebSockets are allowed end-to-end).
    setTimeout(() => {
      if (!errored) signals.circuitConnected = true;
    }, 1500);
  });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    pushCapped(signals.consoleErrors, text);
    if (CIRCUIT_HINT.test(text)) pushCapped(signals.circuitConsoleErrors, text);
  });

  page.on("pageerror", (err) => {
    const text = err.message;
    pushCapped(signals.consoleErrors, text);
    if (CIRCUIT_HINT.test(text)) pushCapped(signals.circuitConsoleErrors, text);
  });

  return signals;
}

function pushCapped(arr: string[], value: string): void {
  if (arr.length < MAX_CONSOLE) arr.push(value);
}

/**
 * Waits until the Blazor circuit transport is actually connected (see
 * `circuitConnected`), then a short settle so the first interaction isn't dropped.
 * Returns false if it never connected within `timeoutMs` (the multi-instance bug:
 * the long-poll request keeps landing on the wrong instance and 404s).
 */
export async function waitForCircuit(
  page: Page,
  signals: CircuitSignals,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signals.circuitConnected) {
      await page.waitForTimeout(500);
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

/**
 * Polls the reconnect modal's visibility/state for the lifetime of the client.
 * Updates the passed-in signals object. Returns a stop() function.
 *
 * The modal is `<dialog id="components-reconnect-modal">`; Blazor adds the `open`
 * attribute and toggles `components-reconnect-*-visible` paragraphs.
 */
export function watchReconnectModal(page: Page, signals: CircuitSignals): () => void {
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      try {
        const state = await page.evaluate(() => {
          const dlg = document.getElementById("components-reconnect-modal") as HTMLDialogElement | null;
          if (!dlg) return { open: false, failed: false };
          const open = dlg.open || dlg.hasAttribute("open");
          // The "Failed to rejoin" paragraph is shown via the components-reconnect-failed-visible class.
          const failedEl = dlg.querySelector(".components-reconnect-failed-visible") as HTMLElement | null;
          const failed =
            open && !!failedEl && failedEl.offsetParent !== null;
          return { open, failed };
        });
        if (state.open) signals.sawReconnectModal = true;
        if (state.failed) signals.sawRejoinFailed = true;
      } catch {
        // page closed / navigating — stop quietly
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
