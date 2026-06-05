# O11yParty concurrency tests

Drives **real Blazor Server circuits** against the deployed buzzer and game on AWS App Runner
to reproduce — and later verify the fix for — the `/_blazor` **404 affinity failure** seen at
AWS Summit Toronto.

## Why this only works against the deployed apps

Both apps are Blazor Server: every UI interaction rides a persistent SignalR circuit at
`/_blazor`. App Runner has **no session affinity**, so when it autoscales past one instance
under load, SignalR follow-up requests land on an instance that doesn't own the circuit and get
`404 "No Connection with that ID"`. A local single-process run has only one instance, so the
circuit is trivially sticky and the bug **cannot** reproduce. These tests therefore target the
deployed URLs and push enough concurrent circuits to trigger autoscaling.

### What validating the harness already revealed

Confirmed live against the current deployment (low load):

- **App Runner blocks the WebSocket** — the `wss://.../_blazor` upgrade returns **403**, and
  SignalR logs *"check that sticky sessions are enabled."* It then falls back to **long
  polling**, which takes ~3–5s to connect. This is the normal/healthy state here and is **not**
  itself the failure — interactivity works once long polling is up. The harness therefore waits
  for the transport to actually connect before interacting (see `waitForCircuit`), and pass/fail
  keys off the long-poll **404** under load, not the WS 403.
- At low concurrency a single user buzzes fine (App Runner stays on one instance) — matching
  what you see by hand. The failure is a **load/scale** effect; you need enough concurrent
  circuits (≈150) to push App Runner to multiple instances before the long-poll 404s appear.
- Incidental, unrelated to App Runner: the game's `QuestionPanel` is passed
  `RemoteBuzzedName="_remoteBuzzedName"`. For a `string` parameter Razor treats the quoted value
  as a **literal**, so it always shows `Buzzed: _remoteBuzzedName`. It should be
  `="@_remoteBuzzedName"` (or unquoted). Worth fixing separately.

## What the tests do

- **`buzzer:load`** — launches `CLIENTS` (default **150**) mobile browser circuits in `WAVES`
  (default 5) staggered batches against the buzzer. Each completes the lead gate, enters a team
  name, taps **BUZZ**, and we record the outcome (`success` / `timeout` / `lead-gate-stuck` /
  `error-status`) plus every `/_blazor` HTTP status, WebSocket failures, and reconnect-modal
  appearances.
- **`game:e2e`** — opens one game host, drives it to the Question phase (where it polls New
  Relic for buzzes), fires a small burst of buzzers, and checks whether the game displays a buzz
  highlight. Its **pass gate is circuit health** (game reaches the Question phase, no `/_blazor`
  404) — the thing the App Runner fix addresses. Whether the buzz is *displayed* depends on
  server-side NR polling latency/config and is reported as an observation; set
  `REQUIRE_BUZZ_DISPLAY=1` to make it gate pass/fail. (In validation the highlight did not appear
  even under healthy low load with no `/_blazor` 404 — a game-side NR-polling matter, not the
  circuit bug.)

Each run prints a summary and writes a JSON artifact to `reports/`, named
`<kind>-<RUN_TAG>-<timestamp>.json`. Writes are **additive** — runs never overwrite or delete
each other (the code only ever creates files). `reports/` is gitignored, so copy any baseline
you care about somewhere durable (e.g. `reports/BASELINE-...json`, or out of the repo). Diff the
**baseline**
(today) against the **post-fix** report as proof.

## Setup

```bash
cd concurrency-tests
npm install
npx playwright install chromium
```

## Run

### Baseline (today — documents the current failure, never fails the process)

```bash
npm run baseline           # buzzer:load + game:e2e with PASS_THRESHOLD=0
```

Expect to see `/_blazor` **404s**, reconnect-modal hits, and a success rate well under 100%;
the game E2E may not display a buzz. Keep `reports/*.json`.

### Reproducing the bug (single-instance saturation)

**Corrected root cause.** During the Summit, App Runner stayed at **1 active instance** (config:
Concurrency 100, Min 1, Max 25) while **CPU, memory, and concurrency all spiked**. So the 404 is
**not** multi-instance circuit re-routing — it's **single-instance saturation**:

- Blazor Server keeps every user's circuit **in server memory**, and re-renders server-side on
  each interaction. A crowd of held-open circuits is expensive in CPU + memory.
- App Runner autoscales on **request concurrency**, but Blazor's long-poll transport keeps the
  in-flight request count **low** (one hanging poll per client), so concurrency rarely crosses
  100 — App Runner never adds an instance even as CPU/memory saturate.
- The one saturated instance can't service long polls / keep-alives within SignalR's timeouts,
  so circuits are dropped/evicted (default `DisconnectedCircuitMaxRetained` is 100). The client's
  next poll references a connection the server no longer has → **`GET /_blazor` 404 "No
  Connection with that ID"** → BUZZ does nothing.

To reproduce, saturate the single instance with held-open circuits **at the default config**
(do NOT lower concurrency — that would instead trigger a *different*, multi-instance affinity
404):

```bash
CLIENTS=150 SOAK_SECONDS=180 PASS_THRESHOLD=0 npm run buzzer:load
```

Watch the App Runner **CPU / memory** metrics (not the instance count). As they saturate, expect
`clients that saw a /_blazor 404`, `reconnect modal`, and `soak re-buzzes that failed/dropped`
to climb, and the success rate / p95 time-to-success to degrade. Increase `CLIENTS` until the
instance saturates (depends on its size; the default is 1 vCPU / 2 GB). Running this many
Chromium contexts is heavy — run from a beefy machine or split across machines/runs.

Note the autoscaling trap: lowering `Concurrency` to force a scale-out does **not** fix this —
Blazor Server has no session affinity on App Runner, so 2+ instances reintroduce the re-routing
404. The durable fix is to stop holding a per-user server circuit (stateless buzz POST / WASM)
and/or give the instance more CPU/memory.

### After the fix is deployed (asserts a clean run)

```bash
npm run buzzer:load        # exits non-zero unless successRate >= 0.99 AND zero /_blazor 404s
npm run game:e2e           # exits non-zero unless a buzz is displayed with no game-side 404s
```

Diff the new reports against the baseline.

## Configuration (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `BUZZER_URL` | `https://9pzprw6pt4.us-east-1.awsapprunner.com` | Buzzer target |
| `GAME_URL` | `https://7t94s2zjsd.us-east-1.awsapprunner.com` | Game target |
| `CLIENTS` | `150` | Total concurrent buzzer clients |
| `WAVES` | `5` | Staggered launch waves |
| `WAVE_STAGGER_MS` | `1500` | Delay between waves |
| `GAME_BURST_CLIENTS` | `5` | Buzzers fired during the game E2E |
| `SOAK_SECONDS` | `0` | >0 = hold each circuit open and re-buzz for this long (saturates the instance) |
| `REBUZZ_INTERVAL_MS` | `4000` | Interval between re-buzzes during a soak |
| `PASS_THRESHOLD` | `0.99` | Min buzz success rate to pass (`0` = report-only) |
| `RUN_TAG` | timestamp | Tag stamped into all synthetic data |
| `HEADED` | _(unset)_ | `1` to watch the browsers |
| `TIMEOUT_*_MS` | see `src/config.ts` | Per-step timeouts |

Tip: start small to confirm wiring (`CLIENTS=10 WAVES=2 npm run buzzer:load`), then scale up.
Running 150 Chromium contexts is heavy — reduce `CLIENTS` or raise `WAVES` on a constrained
machine. To keep production New Relic clean, point `BUZZER_URL`/`GAME_URL` at a staging
deployment.

## New Relic side effects & cleanup

Runs publish **real** events into the production account:
`O11yPartyBuzz` (buzzes) and `O11yPartyLeadCapture` (lead form). The event type is set
server-side, so test data lands alongside real data. Everything is tagged `LOADTEST-...` via
`RUN_TAG`, so you can exclude it from analyses:

```sql
-- exclude test buzzes
FROM O11yPartyBuzz SELECT count(*) WHERE teamName NOT LIKE 'LOADTEST-%' SINCE 1 day ago
```

New Relic NRDB is immutable (you cannot delete individual rows). To stop **future** test runs
from being stored, add NRQL drop rules (Data management → Drop filters), e.g.:

```sql
FROM O11yPartyBuzz        SELECT * WHERE teamName LIKE 'LOADTEST-%'
FROM O11yPartyLeadCapture SELECT * WHERE LastName LIKE 'LOADTEST-%'
```

(Confirm the exact attribute names against your buzz/lead-capture payload before enabling.)

## How failure shows up in a report

| Field | Baseline (broken) | Post-fix (good) |
|-------|-------------------|-----------------|
| `outcomes.success` / `successRate` | low | ~all / ≥ 0.99 |
| `outcomes.timeout` + `lead-gate-stuck` | high (dead circuits) | ~0 |
| `clientsWithBlazor404` | **> 0** | **0** |
| `clientsWithReconnectModal` | > 0 | ~0 |
| game `buzzDisplayed` | often `false` | `true` |

`reports/` is gitignored; copy the baseline JSON somewhere durable before the fix lands.
