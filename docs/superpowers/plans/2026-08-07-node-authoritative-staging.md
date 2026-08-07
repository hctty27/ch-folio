# Node.js Authoritative Staging Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-closed Node benchmark observability, run the exact 36,000-tick hard gate on `hk-server`, and prepare a non-production systemd + Cloudflare Tunnel staging service for eight-client hosted validation without changing production protocol v1.

**Architecture:** Keep deterministic simulation and benchmark codecs in `@ch-folio/authoritative-physics`; add Node-local metrics and authenticated benchmark summary handling inside `authoritative-node`; add a Node-specific eight-client report adapter while preserving the historical Durable Object load script. Staging installs to `/opt/ch-folio-authoritative-staging`, binds only to `127.0.0.1:8080`, runs under systemd, and is published through a dedicated locally-managed Cloudflare Tunnel hostname supplied at deployment time.

**Tech Stack:** Node.js 24 ESM, Node test runner, deterministic Rapier `0.17.3`, `ws` `8.21.1`, systemd, `cloudflared`, GitHub Actions self-hosted Linux x64 runner.

## Global Constraints

- Protocol version remains exactly `2`.
- Rapier deterministic version remains exactly `0.17.3`.
- Vehicle physics and map collision versions remain unchanged.
- Maximum room size remains exactly eight sessions.
- Simulation remains fixed at 60 Hz; state broadcast remains 20 Hz.
- Input buffering remains exactly three ticks.
- Disconnect grace remains exactly 180 ticks.
- Production protocol v1 and `VITE_MULTIPLAYER_ENABLED`, `VITE_MULTIPLAYER_PROTOCOL`, `VITE_SERVER_URL` remain unchanged.
- Node staging binds only to `127.0.0.1:8080`.
- Benchmark token length is at least 32 characters, never appears in a URL, and is never printed in reports or logs.
- Local hard gates remain `p95 <= 8.000 ms`, `p99 <= 12.000 ms`, `max <= 16.670 ms`, queue depth `<= 3`, persistent divergence `0`, disconnects `0`.
- Hosted hard gates add scheduler overload callbacks `0` and staging process restarts `0`.
- Node RSS is evidence only; the Durable Object `96 MiB` isolate limit is not a Node hard gate.
- Any CI or 36,000-tick hard-gate failure stops staging deployment.

---

### Task 1: Node benchmark metrics primitive

**Files:**
- Create: `authoritative-node/src/Metrics.js`
- Create: `authoritative-node/test/metrics.test.mjs`

**Interfaces:**
- Produces `Metrics.recordPhase(name, milliseconds)`, `recordSchedulerCallback(dueTicks, executedTicks)`, `recordQueueDepth(depth)`, `setSlots(slots)`, `recordDisconnect()`, `completeTick(tick)`, and `readBenchmarkSummary()`.
- `readBenchmarkSummary()` returns `{ startTick, endTick, ticks, phases, scheduler, gauges, disconnects }` and retains at most the latest 36,000 ticks.

- [ ] **Step 1: Write failing metrics tests**

Create tests for nearest-rank p50/p95/p99/max, queue and slot maxima, scheduler overload accounting, disconnect count, strictly increasing ticks, zero-filled newly appearing phases, and the 36,000-tick cap. Representative contract:

```js
const metrics = new Metrics()
metrics.recordPhase('totalTick', 4)
metrics.recordQueueDepth(2)
metrics.setSlots(8)
metrics.recordSchedulerCallback(4, 3)
metrics.recordDisconnect()
metrics.completeTick(1)
const summary = metrics.readBenchmarkSummary()
assert.equal(summary.phases.totalTick.p95Ms, 4)
assert.equal(summary.scheduler.overloadCallbacks, 1)
assert.equal(summary.gauges.maxQueueDepth, 2)
assert.equal(summary.gauges.maxSlots, 8)
assert.equal(summary.disconnects, 1)
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test authoritative-node/test/metrics.test.mjs
```

Expected: FAIL because `Metrics.js` is missing.

- [ ] **Step 3: Implement `Metrics.js`**

Use finite non-negative duration validation, non-negative safe-integer counters, nearest-rank percentiles, a 600-tick rolling operational window, and a separate latest-36,000-tick benchmark window. Scheduler state is exactly:

```js
{ callbacks: 0, catchUpTicks: 0, overloadCallbacks: 0, maxDueTicks: 0 }
```

`recordSchedulerCallback()` increments `overloadCallbacks` whenever `dueTicks > executedTicks`.

- [ ] **Step 4: Verify GREEN**

```bash
node --test authoritative-node/test/metrics.test.mjs
npm test --prefix authoritative-node
```

- [ ] **Step 5: Commit**

```bash
git add authoritative-node/src/Metrics.js authoritative-node/test/metrics.test.mjs
git commit -m "feat: add Node benchmark metrics"
```

---

### Task 2: Instrument live Node room timing, queue, slots, disconnects, and scheduler

**Files:**
- Modify: `authoritative-node/src/NodeAuthoritativeRoom.js`
- Modify: `authoritative-node/test/room.test.mjs`
- Modify: `authoritative-node/test/protocol.test.mjs`

**Interfaces:**
- Consumes `Metrics` from Task 1 and the existing `TickScheduler({ onTick, onCallback, clock })` callback.
- Produces `NodeAuthoritativeRoom.metrics` and `NodeAuthoritativeRoom.readQueueDepth()`.

- [ ] **Step 1: Write failing room instrumentation tests**

Assert an `autoSchedule: false` room exposes metrics, records three advanced ticks, records maximum slot count, and computes queue depth from `slot.queuedInputs.size`. Add a protocol disconnect test that records exactly one disconnect when the current controller enters grace.

- [ ] **Step 2: Verify RED**

```bash
node --test authoritative-node/test/room.test.mjs authoritative-node/test/protocol.test.mjs
```

Expected: FAIL because `room.metrics` and `room.readQueueDepth()` are absent.

- [ ] **Step 3: Wire scheduler metrics**

Construct the scheduler as:

```js
this.scheduler = new TickScheduler({
    clock,
    onTick: () => this.advanceOneTick(),
    onCallback: (dueTicks, executedTicks) =>
        this.metrics.recordSchedulerCallback(dueTicks, executedTicks),
})
```

- [ ] **Step 4: Measure each completed live-room tick**

At the beginning of `advanceOneTick()` capture `performance.now()`. After simulation, session expiry, hash scheduling, state broadcasting, and cleanup logic for that tick, record:

```js
this.metrics.recordPhase('totalTick', performance.now() - started)
this.metrics.recordQueueDepth(this.readQueueDepth())
this.metrics.setSlots(this.sessions.size)
this.metrics.completeTick(this.currentTick)
```

Use `recordPhase`, not `recordCompletedTickPhase`, so the first completed tick is valid before the benchmark window has prior samples.

Implement:

```js
readQueueDepth()
{
    if(this.simulation === null)
        return 0
    return this.simulation.slots.reduce((maximum, slot) =>
        Math.max(maximum, slot?.queuedInputs?.size ?? 0), 0)
}
```

- [ ] **Step 5: Verify GREEN**

```bash
node --test authoritative-node/test/room.test.mjs authoritative-node/test/protocol.test.mjs
npm test --prefix authoritative-node
```

- [ ] **Step 6: Commit**

```bash
git add authoritative-node/src/NodeAuthoritativeRoom.js authoritative-node/test/room.test.mjs authoritative-node/test/protocol.test.mjs
git commit -m "feat: instrument Node authoritative rooms"
```

---

### Task 3: Authenticated Node benchmark summary

**Files:**
- Modify: `authoritative-node/src/config.js`
- Modify: `authoritative-node/src/server.js`
- Modify: `authoritative-node/src/RoomRegistry.js`
- Modify: `authoritative-node/src/NodeAuthoritativeRoom.js`
- Modify: `authoritative-node/test/server.test.mjs`
- Modify: `authoritative-node/test/protocol.test.mjs`

**Interfaces:**
- Consumes shared `BENCHMARK_FRAME_TYPES`, `decodeBenchmarkSummaryRequest`, `digestBenchmarkToken`, `encodeBenchmarkSummary`, `RAPIER_VERSION`, `VERSIONS`.
- Consumes `constantTimeEqual()` from `authoritative-node/src/token.js`.
- Produces `readServerConfig(env).benchmarkToken`: `null` when absent; throws when present and shorter than 32 characters.
- Produces active-session handling for benchmark frame type `SUMMARY_REQUEST` (`9`).

- [ ] **Step 1: Write failing config and protocol tests**

Assert no-token config returns `null`, a short token throws, a valid token never appears in `/healthz`, correct digest yields `BENCHMARK_SUMMARY`, and wrong digest yields controlled `BENCHMARK_UNAVAILABLE` error code `8` without token disclosure.

- [ ] **Step 2: Verify RED**

```bash
node --test authoritative-node/test/server.test.mjs authoritative-node/test/protocol.test.mjs
```

- [ ] **Step 3: Thread benchmark authorization through server -> registry -> room**

Digest the configured token once per room and retain only the digest promise. Add active-frame handling that decodes the request, constant-time compares digests, and sends JSON through `encodeBenchmarkSummary()`.

The Node summary is:

```js
{
    schemaVersion: 1,
    mode: 'node',
    room: this.room,
    currentTick: this.currentTick,
    runtimeStarts: 1,
    roomRestarts: 0,
    rapierVersion: RAPIER_VERSION,
    versions: VERSIONS,
    rapierInternalTimingAvailable: false,
    observedPeakMemoryBytes: process.memoryUsage.rss(),
    memoryScope: 'node-process-rss',
    metrics: this.metrics.readBenchmarkSummary(),
}
```

Process restarts are verified independently through systemd evidence during hosted load; do not fake a cross-process restart counter inside room memory.

- [ ] **Step 4: Verify GREEN**

```bash
node --test authoritative-node/test/server.test.mjs authoritative-node/test/protocol.test.mjs
npm test --prefix authoritative-node
```

- [ ] **Step 5: Commit**

```bash
git add authoritative-node/src/config.js authoritative-node/src/server.js authoritative-node/src/RoomRegistry.js authoritative-node/src/NodeAuthoritativeRoom.js authoritative-node/test/server.test.mjs authoritative-node/test/protocol.test.mjs
git commit -m "feat: expose authenticated Node benchmark summary"
```

---

### Task 4: Node-specific eight-client hosted load harness

**Files:**
- Create: `scripts/loadtest-authoritative-node.mjs`
- Create: `scripts/test_authoritative_node_loadtest.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `parseNodeLoadTestOptions()`, `evaluateNodeLoadTestGates()`, `runNodeLoadTest()`.
- Produces root scripts `test:authoritative-node-loadtest` and `benchmark:authoritative:node`.

- [ ] **Step 1: Write failing parser/gate tests**

Require the same credential-free URL behavior as the Worker harness, exactly eight clients, default 600 seconds, token length >=32, and optional exact commit metadata from `AUTHORITATIVE_BENCHMARK_COMMIT`. Gate on server p95/p99/max, queue depth, scheduler overload, disconnects, backlog, divergence, and room restarts; do not gate Node RSS.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/test_authoritative_node_loadtest.mjs
```

- [ ] **Step 3: Implement the Node harness**

Copy only the stable protocol-v2 client lifecycle from `loadtest-authoritative-worker.mjs`: eight sockets, HELLO/FULL_SYNC, SYNC_READY, 60 Hz batched inputs, 20 Hz state checks, checksum comparison, world-hash comparison, and authenticated summary request. Keep the historical Worker script unchanged.

Normalize the Node result around `server: summary.metrics`, preserve `observedPeakMemoryBytes` as informational, and set `mode: 'deployed-node'`.

- [ ] **Step 4: Add and run scripts**

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

- [ ] **Step 5: Commit**

```bash
git add scripts/loadtest-authoritative-node.mjs scripts/test_authoritative_node_loadtest.mjs package.json
git commit -m "feat: add Node authoritative load harness"
```

---

### Task 5: Fail-closed 36,000-tick GitHub evidence workflow

**Files:**
- Create: `.github/workflows/authoritative-node-benchmark.yml`
- Modify: `docs/multiplayer-authoritative-benchmark.md`

**Interfaces:**
- Consumes `npm run benchmark:authoritative:local -- --output=authoritative-node-local-benchmark.json`.
- Produces artifact `node-authoritative-local-benchmark`.
- Fails the workflow after artifact upload when the benchmark command exits nonzero.

- [ ] **Step 1: Add workflow**

Use self-hosted `[self-hosted, linux, x64]`, Node 24, `push` only for `feat/node-authoritative-staging`, plus `workflow_dispatch`. Run root `npm ci` and Node `npm ci --prefix authoritative-node --ignore-scripts` before the benchmark. Preserve the benchmark exit code, upload JSON with `actions/upload-artifact@v4`, then exit with the preserved status.

- [ ] **Step 2: Document the new Node evidence rule**

State that the prior 74.823649 ms maximum is historical DO-era evidence and cannot be reused or waived; the exact staging commit must generate a new 36,000-tick report.

- [ ] **Step 3: Push and inspect the workflow**

Expected outcome is deliberately binary:

- GREEN -> proceed to Task 6.
- RED -> keep the artifact, stop deployment, debug the failed performance gate.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/authoritative-node-benchmark.yml docs/multiplayer-authoritative-benchmark.md
git commit -m "ci: gate Node authoritative staging benchmark"
```

---

### Task 6: Staging systemd and Cloudflare Tunnel assets

**Precondition:** Task 5 is GREEN.

**Files:**
- Create: `ops/authoritative-node/ch-folio-authoritative-node.service`
- Create: `ops/authoritative-node/install-staging.sh`
- Create: `ops/authoritative-node/render-cloudflared-config.mjs`
- Create: `ops/authoritative-node/README.md`
- Create: `scripts/smoke-authoritative-node-staging.mjs`
- Create: `scripts/test_authoritative_node_staging_ops.mjs`
- Modify: `package.json`

**Interfaces:**
- Deployment inputs: `AUTHORITATIVE_STAGING_HOSTNAME`, `AUTHORITATIVE_STAGING_TUNNEL_ID`, `AUTHORITATIVE_STAGING_TUNNEL_CREDENTIALS_FILE`, `AUTHORITATIVE_BENCHMARK_TOKEN`.
- Install root: `/opt/ch-folio-authoritative-staging`.
- Secret environment file: `/etc/ch-folio-authoritative-staging.env`, mode `0600`.
- Node service: `ch-folio-authoritative-node.service` with `HOST=127.0.0.1`, `PORT=8080`, `Restart=on-failure`.
- Tunnel config: `/etc/cloudflared/ch-folio-authoritative-staging.yml`.

- [ ] **Step 1: Write failing ops rendering tests**

Assert the unit contains the exact loopback host/port and environment file. Assert rendered Tunnel YAML contains one hostname route to `http://127.0.0.1:8080` and a final `- service: http_status:404`, with no benchmark token.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/test_authoritative_node_staging_ops.mjs
```

- [ ] **Step 3: Implement systemd install assets**

`install-staging.sh` must require root, require Node major 24, copy the exact checkout to `/opt/ch-folio-authoritative-staging` excluding `.git` and `node_modules`, run root and Node `npm ci`, install the unit, and run `systemctl daemon-reload`. It leaves the Node service stopped until explicit health preflight.

- [ ] **Step 4: Implement Tunnel config renderer**

Validate a DNS hostname, tunnel UUID, and absolute credentials path, then emit:

```yaml
tunnel: <validated tunnel UUID input>
credentials-file: <validated absolute credentials-file input>
ingress:
  - hostname: <validated staging hostname input>
    service: http://127.0.0.1:8080
  - service: http_status:404
```

The renderer substitutes real validated runtime inputs; angle-bracket labels above document fields and are not emitted literally.

Validate the resulting file with Cloudflare's current CLI form using the config as the process-wide config:

```bash
cloudflared --config /etc/cloudflared/ch-folio-authoritative-staging.yml tunnel ingress validate
```

Cloudflare requires the final ingress rule to be a catch-all. For Linux service installation, use:

```bash
sudo cloudflared --config /etc/cloudflared/ch-folio-authoritative-staging.yml service install
sudo systemctl restart cloudflared
```

- [ ] **Step 5: Implement staging smoke client**

Verify `HELLO_REQUIRED -> RESUME -> FULL_SYNC -> SYNC_READY -> active STATE -> authenticated BENCHMARK_SUMMARY`, and print only endpoint host/path, server tick, Rapier version, compatibility versions, and pass/fail.

- [ ] **Step 6: Verify GREEN**

```bash
node --test scripts/test_authoritative_node_staging_ops.mjs
npm test --prefix authoritative-node
npm test
```

- [ ] **Step 7: Commit**

```bash
git add ops/authoritative-node scripts/smoke-authoritative-node-staging.mjs scripts/test_authoritative_node_staging_ops.mjs package.json
git commit -m "ops: add Node authoritative staging service"
```

---

### Task 7: Execute staging smoke, eight-client 600-second gate, and record evidence

**Preconditions:** Verify GREEN, Task 5 GREEN, Task 6 tests GREEN.

**Files:**
- Create after execution: `docs/multiplayer-authoritative-node-staging-evidence.md`
- Modify after execution: `authoritative-node/README.md`

- [ ] **Step 1: Install exact candidate and create the host-only secret file**

Run `sudo ops/authoritative-node/install-staging.sh`. Populate `/etc/ch-folio-authoritative-staging.env` from the existing secure deployment secret input without echoing it; file mode must be `0600` and the file must contain only `AUTHORITATIVE_BENCHMARK_TOKEN=` plus the secret value.

- [ ] **Step 2: Start Node and verify loopback health**

```bash
sudo systemctl start ch-folio-authoritative-node
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
sudo systemctl status ch-folio-authoritative-node --no-pager
```

- [ ] **Step 3: Render, validate, and start Tunnel**

Render `/etc/cloudflared/ch-folio-authoritative-staging.yml`, run the validated-config ingress check, restart `cloudflared`, and verify public HTTPS `/healthz` before WebSocket load. Cloudflare notes that restarting a tunnel drops existing long-lived WebSocket connections, so no tunnel restart is permitted during a benchmark run.

- [ ] **Step 4: Run protocol smoke**

```bash
npm run smoke:authoritative-node-staging -- --url="wss://$AUTHORITATIVE_STAGING_HOSTNAME/ws"
```

The benchmark token is supplied through the process environment, never the URL.

- [ ] **Step 5: Run exactly eight clients for exactly 600 seconds**

```bash
AUTHORITATIVE_BENCHMARK_URL="wss://$AUTHORITATIVE_STAGING_HOSTNAME/ws" \
AUTHORITATIVE_BENCHMARK_ROOM="node-staging-600s" \
AUTHORITATIVE_BENCHMARK_COMMIT="$(git rev-parse HEAD)" \
npm run benchmark:authoritative:node > authoritative-node-hosted-benchmark.json
```

The token remains inherited from the secure process environment. Exit `0` is required.

- [ ] **Step 6: Verify process restart count externally**

Capture systemd start/activation metadata immediately before and after the 600-second window. Any Node service restart/crash or tunnel restart during the run is a hard failure.

- [ ] **Step 7: Record evidence**

Write exact commit SHA, Verify run, local benchmark run, Node/Rapier/compatibility versions, local p95/p99/max/queue/divergence/disconnect table, public health result, smoke result, hosted p95/p99/max/queue/overload/disconnect/backlog/divergence/restart table, Node RSS as informational, and explicit statement that production protocol v1 remains active and Task 19 has not executed.

If a gate fails, mark the decision `BLOCKED`; do not reinterpret or average away the failure.

- [ ] **Step 8: Run final repository verification**

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

Every command must exit `0`.

- [ ] **Step 9: Commit evidence**

```bash
git add docs/multiplayer-authoritative-node-staging-evidence.md authoritative-node/README.md
git commit -m "docs: record Node authoritative staging evidence"
```

---

## Task 19 boundary

This plan ends after staging evidence. A separate controlled production-cutover task may start only when every gate above is GREEN and reviewed. This plan never changes production `VITE_MULTIPLAYER_ENABLED`, `VITE_MULTIPLAYER_PROTOCOL`, or `VITE_SERVER_URL`.