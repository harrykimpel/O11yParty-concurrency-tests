/**
 * Aggregates buzzer-client results into a report: a console summary plus a
 * timestamped JSON artifact under reports/. The JSON is the durable evidence you
 * diff between the baseline run (today, expected to show /_blazor 404s) and the
 * post-fix run (expected clean).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PASS_THRESHOLD, REPORTS_DIR, RUN_TAG, SOAK_MODE, WAVES } from "./config.js";
import type { BuzzerResult, BuzzOutcome } from "./buzzerClient.js";

export interface BuzzerReport {
  kind: "buzzer-load";
  runTag: string;
  targetUrl: string;
  timestamp: string;
  clients: number;
  waves: number;
  outcomes: Record<BuzzOutcome, number>;
  successRate: number;
  timeToSuccessMs: { p50: number | null; p95: number | null };
  blazorStatusHistogram: Record<string, number>;
  /** Non-OK `/_blazor` responses bucketed by `METHOD endpoint -> status`, so a real
   *  transport poll 404 ("No Connection") is distinguishable from a benign
   *  negotiate/disconnect/connect 404. */
  blazorErrorBreakdown: Record<string, number>;
  clientsWithBlazor404: number;
  /** Clients that got at least one 429 (App Runner rejecting at the concurrency cap). */
  clientsWithBlazor429: number;
  clientsWithBlazorError: number;
  clientsWithReconnectModal: number;
  clientsWithRejoinFailed: number;
  soak: { totalBuzzes: number; failedReBuzzes: number } | null;
  passThreshold: number;
  passed: boolean;
}

/**
 * Buckets a `/_blazor` URL into the SignalR lifecycle stage it belongs to. A 404 on
 * `transport-poll` is the meaningful "No Connection with that ID" (circuit was
 * dropped); 404s on negotiate/disconnect/connect are usually benign teardown/startup
 * noise that SignalR recovers from.
 */
function classifyBlazorEndpoint(url: string): string {
  if (url.includes("/_blazor/negotiate")) return "negotiate";
  if (url.includes("/_blazor/disconnect")) return "disconnect";
  if (url.includes("/_blazor/initializers")) return "initializers";
  if (/\/_blazor\?id=/.test(url)) return "transport-poll";
  return "other";
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function buildBuzzerReport(
  results: BuzzerResult[],
  targetUrl: string,
): BuzzerReport {
  const outcomes: Record<BuzzOutcome, number> = {
    success: 0,
    "error-status": 0,
    "circuit-not-connected": 0,
    "lead-gate-stuck": 0,
    timeout: 0,
    "load-failed": 0,
  };

  const statusHistogram: Record<string, number> = {};
  const errorBreakdown: Record<string, number> = {};
  const successDurations: number[] = [];
  let clientsWithBlazor404 = 0;
  let clientsWithBlazor429 = 0;
  let clientsWithBlazorError = 0;
  let clientsWithReconnectModal = 0;
  let clientsWithRejoinFailed = 0;

  for (const r of results) {
    outcomes[r.outcome] += 1;
    if (r.outcome === "success") successDurations.push(r.durationMs);
    if (r.signals.sawBlazor404) clientsWithBlazor404 += 1;
    if (r.signals.blazorStatusHistogram["429"]) clientsWithBlazor429 += 1;
    if (r.signals.sawBlazorError) clientsWithBlazorError += 1;
    if (r.signals.sawReconnectModal) clientsWithReconnectModal += 1;
    if (r.signals.sawRejoinFailed) clientsWithRejoinFailed += 1;
    for (const [status, count] of Object.entries(r.signals.blazorStatusHistogram)) {
      statusHistogram[status] = (statusHistogram[status] ?? 0) + count;
    }
    for (const ev of r.signals.blazorHttp) {
      if (ev.status === 200 || ev.status === 101 || ev.status === 204) continue;
      const key = `${ev.method} ${classifyBlazorEndpoint(ev.url)} -> ${ev.status}`;
      errorBreakdown[key] = (errorBreakdown[key] ?? 0) + 1;
    }
  }

  let soakTotalBuzzes = 0;
  let soakFailedReBuzzes = 0;
  let anySoak = false;
  for (const r of results) {
    if (r.soakBuzzes !== undefined) {
      anySoak = true;
      soakTotalBuzzes += r.soakBuzzes;
      soakFailedReBuzzes += r.soakBuzzFailures ?? 0;
    }
  }

  const total = results.length || 1;
  const successRate = outcomes.success / total;
  const passed = successRate >= PASS_THRESHOLD && clientsWithBlazor404 === 0;

  return {
    kind: "buzzer-load",
    runTag: RUN_TAG,
    targetUrl,
    timestamp: new Date().toISOString(),
    clients: results.length,
    waves: SOAK_MODE ? 1 : WAVES,
    outcomes,
    successRate,
    timeToSuccessMs: {
      p50: percentile(successDurations, 50),
      p95: percentile(successDurations, 95),
    },
    blazorStatusHistogram: statusHistogram,
    blazorErrorBreakdown: errorBreakdown,
    clientsWithBlazor404,
    clientsWithBlazor429,
    clientsWithBlazorError,
    clientsWithReconnectModal,
    clientsWithRejoinFailed,
    soak: anySoak
      ? { totalBuzzes: soakTotalBuzzes, failedReBuzzes: soakFailedReBuzzes }
      : null,
    passThreshold: PASS_THRESHOLD,
    passed,
  };
}

export function printBuzzerReport(report: BuzzerReport): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const line = "─".repeat(58);
  console.log(`\n${line}`);
  console.log(`  BUZZER LOAD REPORT  (run ${report.runTag})`);
  console.log(`  target: ${report.targetUrl}`);
  console.log(`  ${report.clients} clients in ${report.waves} waves`);
  console.log(line);
  console.log(`  Outcomes:`);
  console.table(report.outcomes);
  console.log(`  success rate ........ ${pct(report.successRate)} (threshold ${pct(report.passThreshold)})`);
  console.log(`  time-to-success p50 . ${fmtMs(report.timeToSuccessMs.p50)}`);
  console.log(`  time-to-success p95 . ${fmtMs(report.timeToSuccessMs.p95)}`);
  console.log(`\n  /_blazor HTTP status histogram:`);
  console.table(report.blazorStatusHistogram);
  if (Object.keys(report.blazorErrorBreakdown).length > 0) {
    console.log(`  /_blazor NON-OK responses by stage (transport-poll 404 = real circuit drop):`);
    console.table(report.blazorErrorBreakdown);
  }
  console.log(`  clients that saw a /_blazor 404 ...... ${report.clientsWithBlazor404}  <-- dropped/unknown circuit`);
  console.log(`  clients that saw a /_blazor 429 ...... ${report.clientsWithBlazor429}  <-- App Runner concurrency cap`);
  console.log(`  clients with any /_blazor error ...... ${report.clientsWithBlazorError}`);
  console.log(`  clients that saw the reconnect modal . ${report.clientsWithReconnectModal}`);
  console.log(`  clients that saw "Failed to rejoin" .. ${report.clientsWithRejoinFailed}`);
  if (report.soak) {
    console.log(`\n  soak re-buzzes ...................... ${report.soak.totalBuzzes}`);
    console.log(`  soak re-buzzes that failed/dropped .. ${report.soak.failedReBuzzes}  <-- real user-facing failures (buzz didn't register)`);
  }
  console.log(line);
  console.log(`  RESULT: ${report.passed ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`${line}\n`);
}

export async function writeReport(
  report: object,
  filenamePrefix: string,
): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true });
  // RUN_TAG in the filename makes each run self-labeled (so baselines are easy to
  // identify and keep); the ms-precision timestamp guarantees we never overwrite or
  // remove a prior report — every run is a new, additive file.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileUrl = new URL(`${filenamePrefix}-${RUN_TAG}-${stamp}.json`, REPORTS_DIR);
  await writeFile(fileUrl, JSON.stringify(report, null, 2), "utf8");
  return fileURLToPath(fileUrl);
}

function fmtMs(ms: number | null): string {
  return ms === null ? "n/a" : `${ms} ms`;
}
