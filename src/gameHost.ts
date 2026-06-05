/**
 * Drives the game host UI into a buzz-accepting state and waits for a buzz to be
 * displayed:
 *
 *   load -> Start Game -> pick a question tile (-> Question phase, starts NR polling)
 *        -> wait for the buzz highlight (.wth-buzz-highlight .buzz-name)
 *
 * The game only displays buzzes it polls back from New Relic, so this verifies the
 * full path the Summit reported broken: buzzer -> NR -> game display.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { GAME_URL, TIMEOUTS } from "./config.js";
import {
  instrument,
  waitForCircuit,
  watchReconnectModal,
  type CircuitSignals,
} from "./instrument.js";

export interface GameHostHandle {
  context: BrowserContext;
  page: Page;
  signals: CircuitSignals;
  stop: () => void;
}

/** Opens the game, advances to Question phase so buzz polling is active. */
export async function openGameInQuestionPhase(browser: Browser): Promise<GameHostHandle> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const signals = instrument(page);
  const stop = watchReconnectModal(page, signals);

  await page.goto(GAME_URL, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUTS.pageLoad,
  });

  // Wait for the circuit transport to connect (WS is 403'd on App Runner -> long
  // polling fallback) before driving the UI, or clicks get dropped.
  await waitForCircuit(page, signals, TIMEOUTS.circuitReady);
  // The first interaction after the circuit connects can be dropped while the
  // component finishes wiring handlers, so each step below is click-until-effect.

  // Board loads asynchronously (~4s artificial delay in OnInitializedAsync); the
  // Start Game button only appears once the board is valid in the Setup phase.
  const startBtn = page.getByRole("button", { name: /start/i }).first();
  await startBtn.waitFor({ state: "visible", timeout: TIMEOUTS.circuitReady });

  // Start Game -> Board phase (question tiles appear).
  const startedOk = await clickUntil(
    page,
    () => startBtn.click({ timeout: TIMEOUTS.uiStep }),
    page.locator("button.wth-tile"),
  );
  if (!startedOk) throw new Error("Start Game did not advance to the board");

  // Click first enabled tile -> Question phase (board replaced by question panel,
  // which calls StartBuzzPolling()). Detect by the board grid disappearing.
  const tile = page.locator("button.wth-tile:not([disabled])").first();
  const questionOk = await clickUntil(
    page,
    () => tile.click({ timeout: TIMEOUTS.uiStep }),
    page.locator(".wth-board"),
    { state: "hidden" },
  );
  if (!questionOk) throw new Error("Tile click did not advance to the question phase");

  return { context, page, signals, stop };
}

/**
 * Waits for any buzz highlight to appear and returns the displayed name, or null
 * if none appeared within the timeout. The game shows only latest(teamName), so we
 * assert that *a* buzz was displayed, not that all were.
 */
export async function waitForBuzzDisplayed(
  page: Page,
  timeoutMs = TIMEOUTS.buzzHighlight,
): Promise<string | null> {
  const name = page.locator(".wth-buzz-highlight .buzz-name");
  try {
    await name.waitFor({ state: "visible", timeout: timeoutMs });
    return (await name.textContent())?.trim() ?? "";
  } catch {
    return null;
  }
}

export async function closeGameHost(handle: GameHostHandle): Promise<void> {
  handle.stop();
  await handle.context.close().catch(() => {});
}

/**
 * Performs `doClick` and waits for `expect` to reach the desired state, retrying
 * the click a few times. Guards against the first-interaction-after-connect drop
 * (and ordinary long-poll latency). Returns true once the condition is met.
 */
async function clickUntil(
  page: Page,
  doClick: () => Promise<void>,
  expect: import("playwright").Locator,
  opts: { state?: "visible" | "hidden"; attempts?: number } = {},
): Promise<boolean> {
  const state = opts.state ?? "visible";
  const attempts = opts.attempts ?? 4;
  for (let i = 0; i < attempts; i++) {
    await doClick().catch(() => {});
    const ok = await expect
      .first()
      .waitFor({ state, timeout: TIMEOUTS.uiStep })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
