/**
 * ENTRY: Buzzer concurrency / load test.
 *
 * Launches CLIENTS real mobile browser circuits against the deployed buzzer in
 * WAVES staggered batches, drives each through the buzz flow, and reports the
 * outcome plus the `/_blazor` circuit signals. Exits non-zero if the run does not
 * meet PASS_THRESHOLD (or if any `/_blazor` 404 is seen) — unless PASS_THRESHOLD=0
 * for a baseline collection run.
 *
 * Usage:
 *   npm run buzzer:load
 *   CLIENTS=150 WAVES=5 npm run buzzer:load
 *   PASS_THRESHOLD=0 npm run buzzer:load     # baseline, never fails
 */

import { chromium, type Browser } from "playwright";
import {
  BUZZER_URL,
  CLIENTS,
  HEADLESS,
  SOAK_MODE,
  SOAK_SECONDS,
  WAVE_STAGGER_MS,
  WAVES,
} from "./config.js";
import { runBuzzerClient, type BuzzerResult } from "./buzzerClient.js";
import { buildBuzzerReport, printBuzzerReport, writeReport } from "./report.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // In soak mode launch everyone at once so concurrency stays at CLIENTS for the
  // whole window (the condition App Runner scales out on); otherwise use waves.
  const effectiveWaves = SOAK_MODE ? 1 : WAVES;
  const waveSize = Math.ceil(CLIENTS / effectiveWaves);
  console.log(
    SOAK_MODE
      ? `Buzzer SOAK: ${CLIENTS} clients holding circuits open for ${SOAK_SECONDS}s against ${BUZZER_URL} (headless=${HEADLESS}).`
      : `Buzzer load: ${CLIENTS} clients against ${BUZZER_URL} in ${effectiveWaves} waves of ~${waveSize} (headless=${HEADLESS}).`,
  );

  const browser: Browser = await chromium.launch({ headless: HEADLESS });
  const results: BuzzerResult[] = [];

  try {
    let index = 0;
    for (let wave = 0; wave < effectiveWaves && index < CLIENTS; wave++) {
      const batch: Promise<BuzzerResult>[] = [];
      for (let i = 0; i < waveSize && index < CLIENTS; i++, index++) {
        batch.push(runBuzzerClient(browser, index));
      }
      const t0 = Date.now();
      const settled = await Promise.allSettled(batch);
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
        // rejections shouldn't happen — runBuzzerClient catches internally — but
        // guard anyway so one bad client can't sink the whole run.
      }
      const done = results.filter((r) => r.outcome === "success").length;
      console.log(
        `  wave ${wave + 1}/${effectiveWaves}: ${batch.length} clients in ${Date.now() - t0} ms  (cumulative success: ${done}/${results.length})`,
      );
      if (wave < effectiveWaves - 1 && index < CLIENTS) await sleep(WAVE_STAGGER_MS);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const report = buildBuzzerReport(results, BUZZER_URL);
  printBuzzerReport(report);
  const path = await writeReport(report, "buzzer-load");
  console.log(`Report written: ${path}`);

  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => {
  console.error("buzzer-load failed:", e);
  process.exit(2);
});
