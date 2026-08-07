# Node.js Authoritative Staging Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-closed Node benchmark observability, run the exact 36,000-tick hard gate on `hk-server`, and prepare a non-production systemd + Cloudflare Tunnel staging service for eight-client hosted validation without changing production protocol v1.

**Architecture:** Keep deterministic simulation and binary benchmark codecs in `@ch-folio/authoritative-physics`, add Node-local metrics and benchmark authorization inside `authoritative-node`, and reuse the existing eight-client load harness through a Node-specific wrapper/report adapter. Staging runs from `/opt/ch-folio-authoritative-staging` on `127.0.0.1:8080`, supervised by systemd and exposed only through a dedicated Cloudflare Tunnel hostname supplied as deployment configuration.

**Tech Stack:** Node.js 24 ESM, Node test runner, deterministic Rapier `0.17.3`, `ws` `8.21.1`, systemd, `cloudflared`, GitHub Actions self-hosted Linux x64 runner.

## Global Constraints

- Protocol version remains exactly `2`.
- Rapier deterministic version remains exactly `0.17.3`.
- Vehicle physics and map collision versions remain unchanged.
- Maximum room size remains exactly eight sessions.
- Simulation remains fixed at 60 Hz; state broadcast remains 20 Hz.
- Input buffering remains exactly three ticks.
- Disconnect grace remains exactly 180 ticks.
- Production protocol v1 and production browser environment variables remain unchanged.
- Node staging binds only to `127.0.0.1:8080`.
- Benchmark token length is at least 32 characters, is never placed in a URL, and is never printed in reports or logs.
- Local benchmark hard gates remain `p95 <= 8.000 ms`, `p99 <= 12.000 ms`, `max <= 16.670 ms`, maximum queue depth `<= 3`, persistent divergence `0`, disconnects `0`.
- Hosted load hard gates remain the same timing/queue/divergence/disconnect limits plus scheduler overload callbacks `0` and staging process restarts `0`.
- Node process RSS is evidence only; the Durable Object `96 MiB` isolate limit is not a Node hard gate.
- Any CI or 36,000-tick hard-gate failure stops staging deployment.

---

### Task 1: Node benchmark metrics primitive

**Files:**
- Create: `authoritative-node/src/Metrics.js`
- Create: `authoritative-node/test/metrics.test.mjs`
- Modify: `authoritative-node/package.json`

**Interfaces:**
- Produces: `new Metrics()`.
- Produces: `Metrics.recordPhase(name, milliseconds)`.
- Produces: `Metrics.recordCompletedTickPhase(name, milliseconds)`.
- Produces: `Metrics.recordSchedulerCallback(dueTicks, executedTicks)`.
- Produces: `Metrics.recordQueueDepth(depth)`.
- Produces: `Metrics.setSlots(slots)`.
- Produces: `Metrics.recordDisconnect()`.
- Produces: `Metrics.completeTick(tick)`.
- Produces: `Metrics.readBenchmarkSummary()` returning `{ startTick, endTick, ticks, phases, scheduler, gauges, disconnects }` with at most the latest 36,000 ticks.

- [ ] **Step 1: Write the failing metrics contract tests**

Create `authoritative-node/test/metrics.test.mjs` with tests that assert nearest-rank `p50/p95/p99/max`, scheduler catch-up/overload accounting, queue/slot maxima, disconnect counting, strict increasing benchmark ticks, zero-filling phases that begin after earlier ticks, and retention of exactly the latest 36,000 ticks.

Use this representative assertion for the summary shape:

```js
const metrics = new Metrics()
metrics.recordPhase('simulation', 4)
metrics.recordQueueDepth(2)
metrics.setSlots(8)
metrics.recordSchedulerCallback(4, 3)
metrics.recordDisconnect()
metrics.completeTick(1)

const summary = metrics.readBenchmarkSummary()
assert.equal(summary.ticks, 1)
assert.equal(summary.phases.simulation.p95Ms, 4)
assert.equal(summary.scheduler.overloadCallbacks, 1)
assert.equal(summary.gauges.maxQueueDepth, 2)
assert.equal(summary.gauges.maxSlots, 8)
assert.equal(summary.disconnects, 1)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test --prefix authoritative-node -- --test-name-pattern='metrics'
```

Expected: FAIL because `../src/Metrics.js` does not exist.

- [ ] **Step 3: Implement the minimal Node `Metrics` class**

Mirror the already-proven Worker metric semantics without importing Worker TypeScript into Node. Keep a rolling 600-tick operational window and a separate capped 36,000-tick benchmark window. Validate all durations as finite non-negative numbers and all counts as non-negative safe integers.

The scheduler summary must be:

```js
{
    callbacks: 0,
    catchUpTicks: 0,
    overloadCallbacks: 0,
    maxDueTicks: 0,
}
```

and `recordSchedulerCallback(dueTicks, executedTicks)` must increment `overloadCallbacks` whenever `dueTicks > executedTicks`.

- [ ] **Step 4: Run metrics and full Node tests**

Run:

```bash
node --test authoritative-node/test/metrics.test.mjs
npm test --prefix authoritative-node
```

Expected: all metrics tests PASS and the existing Node suite remains green.

- [ ] **Step 5: Commit the metrics primitive**

```bash
git add authoritative-node/src/Metrics.js authoritative-node/test/metrics.test.mjs authoritative-node/package.json
git commit -m "feat: add Node benchmark metrics"
```

---

### Task 2: Instrument the live Node room and scheduler

**Files:**
- Modify: `authoritative-node/src/NodeAuthoritativeRoom.js`
- Modify: `authoritative-node/src/TickScheduler.js`
- Modify: `authoritative-node/test/room.test.mjs`
- Modify: `authoritative-node/test/protocol.test.mjs`

**Interfaces:**
- Consumes: `Metrics` from Task 1.
- Produces: `NodeAuthoritativeRoom.metrics`.
- Produces: `NodeAuthoritativeRoom.readQueueDepth()` returning the maximum queued-input count among current simulation slots.
- Extends: existing `TickScheduler({ onTick, onCallback, clock })` callback contract without changing 60 Hz or the three-tick catch-up cap.

- [ ] **Step 1: Add failing instrumentation tests**

Add room tests that create an `autoSchedule: false` room, allocate sessions, queue inputs, advance ticks, and assert:

```js
assert.equal(room.metrics.readBenchmarkSummary().ticks, 3)
assert.equal(room.metrics.readBenchmarkSummary().gauges.maxSlots, 1)
assert.equal(room.readQueueDepth() >= 0, true)
```

Add a scheduler test that invokes a fake-clock callback with four ticks due and asserts the metrics callback receives `(4, 3)` so overload accounting can observe the unexecuted fourth tick.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test authoritative-node/test/room.test.mjs authoritative-node/test/protocol.test.mjs
```

Expected: FAIL because `room.metrics` and `room.readQueueDepth()` are not yet defined.

- [ ] **Step 3: Wire metrics into `NodeAuthoritativeRoom`**

Construct one `Metrics` instance per room. Configure the existing scheduler as:

```js
this.scheduler = new TickScheduler({
    clock,
    onTick: () => this.advanceOneTick(),
    onCallback: (dueTicks, executedTicks) =>
        this.metrics.recordSchedulerCallback(dueTicks, executedTicks),
})
```

In `advanceOneTick()`, measure the complete live-room tick with `performance.now()`, record it as completed-tick phase `totalTick`, record queue depth and slot count, and call `metrics.completeTick(this.currentTick)` only after the simulation tick is complete.

Implement queue depth as:

```js
readQueueDepth()
{
    if(this.simulation === null)
        return 0
    return this.simulation.slots.reduce((maximum, slot) =>
        Math.max(maximum, slot?.queuedInputs?.size ?? 0), 0)
}
```

Record a disconnect once when an active current-generation controller is actually transitioned into grace. Do not count harness-initiated clean shutdown after the benchmark report is collected.

- [ ] **Step 4: Preserve runtime reset semantics**

When the final slot expires and the room runtime is destroyed, reset live simulation state but do not erase benchmark evidence before the room object itself is removed. `destroy()` may discard metrics because the process/room is ending.

- [ ] **Step 5: Run focused and full Node tests**

Run:

```bash
node --test authoritative-node/test/room.test.mjs authoritative-node/test/protocol.test.mjs
npm test --prefix authoritative-node
```

Expected: all tests PASS; tick cadence, spawn, resume, and deterministic fixture tests remain unchanged.

- [ ] **Step 6: Commit live instrumentation**

```bash
git add authoritative-node/src/NodeAuthoritativeRoom.js authoritative-node/src/TickScheduler.js authoritative-node/test/room.test.mjs authoritative-node/test/protocol.test.mjs
git commit -m "feat: instrument Node authoritative rooms"
```

---

### Task 3: Add authenticated Node benchmark summary frames

**Files:**
- Modify: `authoritative-node/src/config.js`
- Modify: `authoritative-node/src/server.js`
- Modify: `authoritative-node/src/RoomRegistry.js`
- Modify: `authoritative-node/src/NodeAuthoritativeRoom.js`
- Modify: `authoritative-node/test/server.test.mjs`
- Modify: `authoritative-node/test/protocol.test.mjs`

**Interfaces:**
- Consumes: shared `BENCHMARK_FRAME_TYPES`, `decodeBenchmarkSummaryRequest`, `digestBenchmarkToken`, `encodeBenchmarkSummary`, `RAPIER_VERSION`, and `VERSIONS` from `@ch-folio/authoritative-physics`.
- Consumes: `constantTimeEqual(left, right)` from `authoritative-node/src/token.js`.
- Produces: `readServerConfig(env).benchmarkToken`, equal to `null` when unset and rejected when present with fewer than 32 characters.
- Produces: active-session handling for `BENCHMARK_SUMMARY_REQUEST`.

- [ ] **Step 1: Add failing configuration tests**

In `server.test.mjs`, assert:

```js
assert.equal(readServerConfig({ HOST: '127.0.0.1', PORT: '8080' }).benchmarkToken, null)
assert.throws(
    () => readServerConfig({ AUTHORITATIVE_BENCHMARK_TOKEN: 'short' }),
    /at least 32 characters/,
)
```

and assert a 32+ character token is returned verbatim to internal configuration but never appears in `/healthz` JSON.

- [ ] **Step 2: Add failing protocol tests for summary authorization**

Start a loopback server with a fixed benchmark token. After HELLO/FULL_SYNC, send `encodeBenchmarkSummaryRequest()` with the correct token digest and assert `decodeBenchmarkSummary()` returns:

```js
{
    schemaVersion: 1,
    mode: 'node',
    room: 'benchmark',
    currentTick: room.currentTick,
    runtimeStarts: 1,
    roomRestarts: 0,
    rapierVersion: '0.17.3',
    versions: { protocol: 2, vehiclePhysics: 1, mapCollision: 1 },
    metrics: room.metrics.readBenchmarkSummary(),
}
```

Add a second client using a wrong digest and assert it receives `BENCHMARK_UNAVAILABLE` and closes without revealing the configured token or expected digest.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test authoritative-node/test/server.test.mjs authoritative-node/test/protocol.test.mjs
```

Expected: FAIL because benchmark configuration and frame handling are missing.

- [ ] **Step 4: Thread benchmark authorization through server -> registry -> room**

Store only a promise of the configured token digest in each room, not the plaintext token. Add error code `8` with message `BENCHMARK_UNAVAILABLE`. The active-frame handler must decode the shared summary request, constant-time compare the supplied digest, and send `encodeBenchmarkSummary(...)` only on a match.

The summary must include process evidence that is meaningful on Node:

```js
{
    schemaVersion: 1,
    mode: 'node',
    room: this.room,
    currentTick: this.currentTick,
    runtimeStarts: this.runtimeGeneration,
    roomRestarts: 0,
    rapierVersion: RAPIER_VERSION,
    versions: VERSIONS,
    rapierInternalTimingAvailable: false,
    observedPeakMemoryBytes: process.memoryUsage.rss(),
    memoryScope: 'node-process-rss',
    metrics: this.metrics.readBenchmarkSummary(),
}
```

Do not put token state into `summary()`, `/healthz`, logs, close reasons, or report metadata.

- [ ] **Step 5: Run protocol, server, and full Node tests**

Run:

```bash
node --test authoritative-node/test/server.test.mjs authoritative-node/test/protocol.test.mjs
npm test --prefix authoritative-node
```

Expected: all tests PASS, including wrong-token rejection and existing binary-only lifecycle tests.

- [ ] **Step 6: Commit benchmark summary support**

```bash
git add authoritative-node/src/config.js authoritative-node/src/server.js authoritative-node/src/RoomRegistry.js authoritative-node/src/NodeAuthoritativeRoom.js authoritative-node/test/server.test.mjs authoritative-node/test/protocol.test.mjs
git commit -m "feat: expose authenticated Node benchmark summary"
```

---

### Task 4: Add Node-specific eight-client hosted load harness

**Files:**
- Create: `scripts/loadtest-authoritative-node.mjs`
- Create: `scripts/test_authoritative_node_loadtest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing exported `buildBenchmarkWebSocketUrl()` behavior and protocol-v2 client lifecycle semantics from `scripts/loadtest-authoritative-worker.mjs`.
- Produces: `parseNodeLoadTestOptions(argv, environment)`.
- Produces: `evaluateNodeLoadTestGates(report)`.
- Produces: `runNodeLoadTest(options)`.
- Produces root script: `benchmark:authoritative:node`.

- [ ] **Step 1: Write failing Node load-option/gate tests**

Assert the parser requires exactly eight clients and exactly 600 seconds by default, removes credential-like query parameters, never copies the token into metadata, and accepts these environment variables:

```text
AUTHORITATIVE_BENCHMARK_URL
AUTHORITATIVE_BENCHMARK_ROOM
AUTHORITATIVE_BENCHMARK_TOKEN
AUTHORITATIVE_BENCHMARK_CLIENTS
AUTHORITATIVE_BENCHMARK_SECONDS
AUTHORITATIVE_BENCHMARK_COMMIT
```

Assert a passing report requires:

```js
server.phases.totalTick.p95Ms <= 8
server.phases.totalTick.p99Ms <= 12
server.phases.totalTick.maxMs <= 16.67
server.gauges.maxQueueDepth <= 3
server.scheduler.overloadCallbacks === 0
disconnects === 0
backlog.persistent === 0
divergence.persistent === 0
roomRestarts === 0
```

Do not include a `96 MiB` memory gate.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test scripts/test_authoritative_node_loadtest.mjs
```

Expected: FAIL because `loadtest-authoritative-node.mjs` does not exist.

- [ ] **Step 3: Implement the Node harness by copying only the stable client lifecycle**

Keep the existing Worker evidence script unchanged for historical reproducibility. In the new Node script, use the same eight WebSocket clients, 60 Hz input schedule, 20 Hz state expectations, cross-client checksum checks, world-hash checks, and authenticated summary request.

Normalize the Node report to:

```js
{
    schemaVersion: 1,
    mode: 'deployed-node',
    metadata: {
        room,
        clients: 8,
        seconds: 600,
        tickRateHz: 60,
        expectedStateRateHz: 20,
        commit: options.commit,
        endpoint: `${url.protocol}//${url.host}${url.pathname}`,
        tokenConfigured: true,
        sentTicks: 36000,
        wallDurationMs,
    },
    server: {
        ...summary.metrics,
        observedPeakMemoryBytes: summary.observedPeakMemoryBytes,
        memoryScope: summary.memoryScope,
    },
    disconnects,
    socketErrors,
    backlog,
    divergence,
    roomRestarts: summary.roomRestarts,
    serverSummaryMetadata: {
        currentTick: summary.currentTick,
        runtimeStarts: summary.runtimeStarts,
        rapierVersion: summary.rapierVersion,
        versions: summary.versions,
    },
    gates,
}
```

- [ ] **Step 4: Add root commands and run tests**

Add:

```json
"test:authoritative-node-loadtest": "node --test scripts/test_authoritative_node_loadtest.mjs",
"benchmark:authoritative:node": "node scripts/loadtest-authoritative-node.mjs"
```

Run:

```bash
npm run test:authoritative-node-loadtest
npm run test:authoritative-benchmark
npm test
```

Expected: all PASS, including the unchanged Durable Object benchmark contract tests.

- [ ] **Step 5: Commit the Node load harness**

```bash
git add scripts/loadtest-authoritative-node.mjs scripts/test_authoritative_node_loadtest.mjs package.json
git commit -m "feat: add Node authoritative load harness"
```

---

### Task 5: Add the fail-closed 36,000-tick evidence workflow

**Files:**
- Create: `.github/workflows/authoritative-node-benchmark.yml`
- Modify: `docs/multiplayer-authoritative-benchmark.md`

**Interfaces:**
- Consumes: `npm run benchmark:authoritative:local -- --output=authoritative-node-local-benchmark.json`.
- Produces: GitHub artifact `node-authoritative-local-benchmark` containing the JSON report.
- Produces: a workflow failure when any existing local hard gate fails.

- [ ] **Step 1: Create a workflow that runs only on the staging branch or manual dispatch**

Use:

```yaml
name: Node Authoritative Benchmark

on:
  push:
    branches:
      - feat/node-authoritative-staging
  workflow_dispatch:

permissions:
  contents: read

jobs:
  local-36000-tick:
    runs-on: [self-hosted, linux, x64]
    timeout-minutes: 10
```

The steps must checkout the exact commit, install root dependencies with `npm ci`, install Node dependencies with `npm ci --prefix authoritative-node --ignore-scripts`, run the benchmark into JSON while preserving its exit code, upload the JSON with `actions/upload-artifact@v4`, then exit with the original benchmark status.

Use shell structure that uploads failure evidence before failing:

```bash
set +e
npm run benchmark:authoritative:local -- --output=authoritative-node-local-benchmark.json
status=$?
set -e
echo "BENCHMARK_STATUS=$status" >> "$GITHUB_ENV"
```

and after upload:

```bash
exit "$BENCHMARK_STATUS"
```

- [ ] **Step 2: Document that the previous DO-era 74.823649 ms maximum is not reusable evidence**

Append a Node staging section to `docs/multiplayer-authoritative-benchmark.md` stating that a new exact-commit 36,000-tick report is mandatory and that the workflow intentionally fails closed on `totalTick.maxMs > 16.670`.

- [ ] **Step 3: Validate the workflow through GitHub Actions**

Push the workflow commit to `feat/node-authoritative-staging`. Inspect the resulting `Node Authoritative Benchmark` run and its artifact.

Expected outcomes are intentionally binary:

- GREEN: all five local hard gates pass; proceed to Task 6.
- RED: preserve the JSON artifact, do not deploy staging, and begin performance debugging against the failed gate.

- [ ] **Step 4: Commit the evidence workflow**

```bash
git add .github/workflows/authoritative-node-benchmark.yml docs/multiplayer-authoritative-benchmark.md
git commit -m "ci: gate Node authoritative staging benchmark"
```

---

### Task 6: Add staging service and Tunnel deployment assets

**Precondition:** Task 5's exact candidate 36,000-tick workflow is GREEN. Do not execute this task when the benchmark workflow is RED.

**Files:**
- Create: `ops/authoritative-node/ch-folio-authoritative-node.service`
- Create: `ops/authoritative-node/install-staging.sh`
- Create: `ops/authoritative-node/render-cloudflared-config.mjs`
- Create: `ops/authoritative-node/README.md`
- Create: `scripts/smoke-authoritative-node-staging.mjs`
- Create: `scripts/test_authoritative_node_staging_ops.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes deployment inputs: `AUTHORITATIVE_STAGING_HOSTNAME`, `AUTHORITATIVE_STAGING_TUNNEL_ID`, `AUTHORITATIVE_STAGING_TUNNEL_CREDENTIALS_FILE`, `AUTHORITATIVE_BENCHMARK_TOKEN`.
- Produces install root: `/opt/ch-folio-authoritative-staging`.
- Produces environment file: `/etc/ch-folio-authoritative-staging.env`, mode `0600`.
- Produces systemd unit: `ch-folio-authoritative-node.service` bound to `127.0.0.1:8080`.
- Produces Cloudflare config: `/etc/cloudflared/ch-folio-authoritative-staging.yml`.
- Produces smoke command: `npm run smoke:authoritative-node-staging -- --url=wss://$AUTHORITATIVE_STAGING_HOSTNAME/ws`.

- [ ] **Step 1: Write failing operations rendering tests**

Test the committed systemd unit text and config renderer. Assert the service contains:

```ini
Environment=HOST=127.0.0.1
Environment=PORT=8080
EnvironmentFile=/etc/ch-folio-authoritative-staging.env
Restart=on-failure
```

Assert rendered Tunnel YAML contains exactly one hostname route to `http://127.0.0.1:8080` followed by:

```yaml
- service: http_status:404
```

and contains no benchmark token.

- [ ] **Step 2: Run the operations tests and verify RED**

Run:

```bash
node --test scripts/test_authoritative_node_staging_ops.mjs
```

Expected: FAIL because staging assets do not yet exist.

- [ ] **Step 3: Implement the systemd unit and install script**

The unit must use `/opt/ch-folio-authoritative-staging` as `WorkingDirectory`, run `npm start --prefix authoritative-node`, restart only on failure, and load the benchmark secret from `/etc/ch-folio-authoritative-staging.env`.

`install-staging.sh` must fail unless run as root, require Node major version 24, create `/opt/ch-folio-authoritative-staging`, copy the exact checked-out repository tree excluding `.git` and `node_modules`, run both root and Node `npm ci`, install the unit, call `systemctl daemon-reload`, and leave the service stopped until the caller explicitly starts it after health preflight.

- [ ] **Step 4: Implement Cloudflare config rendering and validation command**

`render-cloudflared-config.mjs` must validate hostname syntax, tunnel UUID syntax, and an absolute credentials-file path, then print YAML with:

```yaml
tunnel: ${tunnelId}
credentials-file: ${credentialsFile}
ingress:
  - hostname: ${hostname}
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Document the exact validation command:

```bash
cloudflared tunnel ingress validate --config /etc/cloudflared/ch-folio-authoritative-staging.yml
```

and service commands supported by current Cloudflare Linux documentation:

```bash
sudo cloudflared --config /etc/cloudflared/ch-folio-authoritative-staging.yml service install
sudo systemctl restart cloudflared
sudo systemctl status cloudflared --no-pager
```

- [ ] **Step 5: Implement the public smoke client**

The smoke script must open one protocol-v2 WebSocket, verify `HELLO_REQUIRED -> RESUME -> FULL_SYNC`, send `SYNC_READY`, wait for an active STATE, request a benchmark summary with the configured token, verify `mode === 'node'`, then close cleanly. It must print only bounded metadata: endpoint host/path, server tick, Rapier version, compatibility versions, and pass/fail status.

- [ ] **Step 6: Run local operations and Node regressions**

Run:

```bash
node --test scripts/test_authoritative_node_staging_ops.mjs
npm test --prefix authoritative-node
npm test
```

Expected: all PASS.

- [ ] **Step 7: Commit staging assets**

```bash
git add ops/authoritative-node scripts/smoke-authoritative-node-staging.mjs scripts/test_authoritative_node_staging_ops.mjs package.json
git commit -m "ops: add Node authoritative staging service"
```

---

### Task 7: Execute staging smoke and eight-client hosted gate

**Preconditions:** Verify CI GREEN, Task 5 local 36,000-tick benchmark GREEN, Task 6 operations tests GREEN.

**Files:**
- Create after execution: `docs/multiplayer-authoritative-node-staging-evidence.md`
- Modify after execution: `authoritative-node/README.md`

**Interfaces:**
- Consumes: the exact candidate commit SHA and staging hostname supplied operationally.
- Produces: one evidence document with no secrets and explicit PASS/FAIL for every gate.

- [ ] **Step 1: Install the exact candidate on `hk-server`**

From the exact checked-out commit:

```bash
sudo ops/authoritative-node/install-staging.sh
```

Write `/etc/ch-folio-authoritative-staging.env` with mode `0600` containing only:

```text
AUTHORITATIVE_BENCHMARK_TOKEN=<operator-provided-secret>
```

The secret value must never be committed, echoed, or copied into evidence.

- [ ] **Step 2: Start Node locally and verify loopback health**

Run:

```bash
sudo systemctl start ch-folio-authoritative-node
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
sudo systemctl status ch-folio-authoritative-node --no-pager
```

Expected: health reports ready, protocol `2`, Rapier `0.17.3`, and zero or bounded room/socket counts without exposing the token.

- [ ] **Step 3: Render, validate, and start the dedicated Tunnel**

Render the committed config to `/etc/cloudflared/ch-folio-authoritative-staging.yml`, run:

```bash
cloudflared tunnel ingress validate --config /etc/cloudflared/ch-folio-authoritative-staging.yml
```

then install/restart the `cloudflared` service using the validated config. Verify the public health endpoint over HTTPS before any WebSocket load.

- [ ] **Step 4: Run the protocol smoke client**

Run:

```bash
AUTHORITATIVE_BENCHMARK_TOKEN="$AUTHORITATIVE_BENCHMARK_TOKEN" \
npm run smoke:authoritative-node-staging -- \
  --url="wss://$AUTHORITATIVE_STAGING_HOSTNAME/ws"
```

Expected: PASS with HELLO, FULL_SYNC, active STATE, and authenticated benchmark summary.

- [ ] **Step 5: Run exactly eight clients for exactly 600 seconds**

Run:

```bash
AUTHORITATIVE_BENCHMARK_URL="wss://$AUTHORITATIVE_STAGING_HOSTNAME/ws" \
AUTHORITATIVE_BENCHMARK_ROOM="node-staging-600s" \
AUTHORITATIVE_BENCHMARK_TOKEN="$AUTHORITATIVE_BENCHMARK_TOKEN" \
AUTHORITATIVE_BENCHMARK_COMMIT="$(git rev-parse HEAD)" \
npm run benchmark:authoritative:node > authoritative-node-hosted-benchmark.json
```

Expected: process exit `0` only when every hosted hard gate is green.

- [ ] **Step 6: Check process restart evidence**

Capture systemd activation/start metadata before and after the run. Any service restart, crash, or `systemctl` restart during the 600-second window is a hard failure even if the benchmark JSON otherwise passes.

- [ ] **Step 7: Record evidence without reinterpreting failures**

Create `docs/multiplayer-authoritative-node-staging-evidence.md` containing:

- exact commit SHA;
- Verify run number/conclusion;
- Node Authoritative Benchmark run number/conclusion;
- Node version;
- Rapier `0.17.3`;
- protocol/vehicle/map compatibility tuple;
- 36,000-tick local p95/p99/max/queue/divergence/disconnect table;
- public staging health result;
- smoke result;
- eight-client 600-second p95/p99/max/queue/overload/disconnect/backlog/divergence/restart table;
- Node process RSS observation labelled informational;
- explicit statement that production protocol v1 remains active and Task 19 has not executed.

If any hard gate fails, mark the staging decision `BLOCKED` and stop. Do not average away or waive the failing sample.

- [ ] **Step 8: Run full repository verification one final time**

Run:

```bash
npm ci
node --test packages/authoritative-physics/test/*.test.mjs
npm test
npm run build
npm ci --prefix authoritative-node --ignore-scripts
npm test --prefix authoritative-node
npm install --prefix multiplayer-worker --ignore-scripts
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
cd multiplayer-worker && npx wrangler deploy --dry-run
```

Expected: every command exits `0`.

- [ ] **Step 9: Commit evidence only after results exist**

```bash
git add docs/multiplayer-authoritative-node-staging-evidence.md authoritative-node/README.md
git commit -m "docs: record Node authoritative staging evidence"
```

---

## Task 19 boundary

This plan ends after staging evidence. It must not set or modify production values for:

```text
VITE_MULTIPLAYER_ENABLED
VITE_MULTIPLAYER_PROTOCOL
VITE_SERVER_URL
```

A separate controlled production-cutover task may begin only when every gate in this plan is GREEN and the evidence has been reviewed.