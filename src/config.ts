/**
 * Central configuration for the concurrency tests.
 *
 * Every value can be overridden with an environment variable so the same suite
 * can run against the production App Runner deployment (default) today as a
 * baseline, and again after the fix is deployed (or against a staging URL).
 */

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Deployed targets. Now Amazon ECS Express Mode (App Runner was deprecated).
// The original App Runner URLs that produced the broken-state baseline were:
//   buzzer https://9pzprw6pt4.us-east-1.awsapprunner.com
//   game   https://7t94s2zjsd.us-east-1.awsapprunner.com
// Override either with the BUZZER_URL / GAME_URL env vars. Trailing slash trimmed.
export const BUZZER_URL = envStr(
  "BUZZER_URL",
  "https://o1-8e99538819ca48dd94d1cb48cca3645c.ecs.us-east-1.on.aws",
).replace(/\/+$/, "");

/** Deployed game host app. */
export const GAME_URL = envStr(
  "GAME_URL",
  "https://o1-d00cecaddd4b4c298a7f9408856e06ca.ecs.us-east-1.on.aws",
).replace(/\/+$/, "");

/** Total concurrent buzzer clients to simulate (peak). */
export const CLIENTS = envInt("CLIENTS", 150);

/** Number of staggered waves the clients are launched in. */
export const WAVES = envInt("WAVES", 5);

/** Milliseconds to wait between the start of each wave (crowd ramp-up + local load cap). */
export const WAVE_STAGGER_MS = envInt("WAVE_STAGGER_MS", 1500);

/** How many buzzers the game E2E fires to produce a visible buzz. */
export const GAME_BURST_CLIENTS = envInt("GAME_BURST_CLIENTS", 5);

/**
 * Soak duration in seconds. When > 0, each client HOLDS its /_blazor circuit open
 * and re-buzzes every REBUZZ_INTERVAL_MS for this long, instead of buzzing once and
 * leaving. This reproduces the Summit failure: many held-open Blazor Server circuits
 * saturate the SINGLE App Runner instance (CPU/memory), so it drops/evicts circuits
 * and reconnecting clients get `/_blazor` 404 "No Connection with that ID". App
 * Runner doesn't scale out because long polling keeps request-concurrency low. Run at
 * the DEFAULT App Runner config and watch CPU/memory, not the instance count.
 */
export const SOAK_SECONDS = envInt("SOAK_SECONDS", 0);

/** Interval between re-buzzes during a soak. */
export const REBUZZ_INTERVAL_MS = envInt("REBUZZ_INTERVAL_MS", 4000);

/**
 * In soak mode, launch all clients at once (no wave stagger) so concurrency is
 * sustained at CLIENTS for the whole window — the condition App Runner scales on.
 */
export const SOAK_MODE = SOAK_SECONDS > 0;

/**
 * Minimum buzz success rate (0..1) required for a run to PASS.
 * Set PASS_THRESHOLD=0 for a baseline run that only collects data without failing.
 */
export const PASS_THRESHOLD = envFloat("PASS_THRESHOLD", 0.99);

/**
 * A short tag stamped into every synthetic record so the data is obviously test
 * data and can be filtered/dropped in New Relic (e.g. teamName LIKE 'LOADTEST-%').
 * Defaults to a timestamp so concurrent runs don't collide.
 */
export const RUN_TAG = envStr(
  "RUN_TAG",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, ""),
);

/** Per-client timeouts (ms). */
export const TIMEOUTS = {
  /** Initial page load / DOM ready. */
  pageLoad: envInt("TIMEOUT_PAGE_LOAD_MS", 30_000),
  /** Wait for the Blazor circuit to come up before we start interacting. */
  circuitReady: envInt("TIMEOUT_CIRCUIT_MS", 20_000),
  /** Wait for a UI step (lead gate transition, buzz success status). */
  uiStep: envInt("TIMEOUT_UI_STEP_MS", 15_000),
  /** Game: wait for a buzz highlight to appear (covers NR ingest + poll latency). */
  buzzHighlight: envInt("TIMEOUT_BUZZ_HIGHLIGHT_MS", 90_000),
};

/** Run headless unless HEADED=1. */
export const HEADLESS = envStr("HEADED", "") !== "1";

/**
 * When set (REQUIRE_BUZZ_DISPLAY=1), the game E2E only passes if the buzz is
 * actually displayed in the game. Off by default because buzz display depends on
 * server-side New Relic polling latency/config, which is independent of the App
 * Runner circuit bug the suite targets.
 */
export const REQUIRE_BUZZ_DISPLAY = envStr("REQUIRE_BUZZ_DISPLAY", "") === "1";

export const REPORTS_DIR = new URL("../reports/", import.meta.url);

export function buzzerName(index: number): string {
  return `LOADTEST-${RUN_TAG}-${index}`;
}

export function buzzerEmail(index: number): string {
  // Passes the app's regex ^[^\s@]+@[^\s@]+\.[^\s@]{2,}$ and uses the reserved
  // .test TLD so it can never reach a real mailbox.
  return `loadtest-${RUN_TAG}-${index}@example.test`;
}
