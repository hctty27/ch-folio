# Server-Tick Aligned Prediction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current browser-local tick / whole-world rollback loop with server-tick aligned owner prediction and remote interpolation so protocol-v2 driving remains responsive and smooth under realistic Internet RTT while Node remains authoritative for collisions and final state.

**Architecture:** The browser will maintain an explicit estimated server timeline. The local owner predicts ahead of that timeline by a bounded command lead, while each input carries the existing 32-bit `clientTick` as the server command tick that the Node three-tick input buffer will consume. Local reconciliation becomes entity-scoped and replay uses a separate physical `predictionTick`; remote vehicles leave `PredictionWorld` and render from bounded authoritative snapshot buffers.

**Tech Stack:** JavaScript ES modules, Node 24 test runner, Vite 7, `@dimforge/rapier3d-deterministic@0.17.3`, existing `@ch-folio/authoritative-physics` package, Node WebSocket authority, Cloudflare Pages/Tunnel.

## Global Constraints

- Physics simulation stays **60 Hz**.
- Authoritative STATE broadcast stays **20 Hz**.
- Preserve protocol-v2 binary frame layout; do not bump protocol version for this redesign.
- Preserve Node `INPUT_BUFFER_TICKS = 3` and deterministic server collision timing.
- Preserve current Rapier version, vehicle tuning, map collision, mass, suspension, engine, wheel and CCD settings.
- Only the local owner is predicted from immediate local input; remote players are render-interpolated from authoritative STATE samples.
- Initial command lead: **8 ticks**; minimum **4 ticks**; maximum **18 ticks**; safety slack **2 ticks**.
- Initial remote interpolation delay: **6 ticks / 100 ms**; maximum **12 ticks**.
- Maximum remote extrapolation: **3 ticks / 50 ms**.
- Initial local soft correction thresholds: position **0.05 m**, rotation **1 degree**, linear velocity **0.25 m/s**, angular velocity **0.10 rad/s**.
- Existing hard visual snap thresholds remain **3 m** and **90 degrees**.
- Full sync/resume remains the recovery path for missing history, large clock discontinuity, topology mismatch and incompatible state.
- UInt32 tick comparisons must be wrap-safe; ordinary numeric `<`, `>`, subtraction or sorting is not allowed for timeline ordering across wrap.
- No health/performance gate is removed without a bounded replacement metric.

---

## File Structure

### New files

- `sources/Game/MultiplayerV2/TickMath.js` — wrap-safe uint32 tick arithmetic and ordering only.
- `sources/Game/MultiplayerV2/TickSynchronizer.js` — server tick estimate, RTT/jitter EWMA, adaptive command lead and interpolation target.
- `sources/Game/MultiplayerV2/PredictionInputHistory.js` — local-owner input history keyed by physical `predictionTick` while retaining the serialized command tick and sequence.
- `sources/Game/MultiplayerV2/RemoteSnapshotBuffer.js` — bounded authoritative snapshot interpolation/extrapolation for one remote entity.
- `scripts/test_v2_tick_synchronizer.mjs` — tick math/synchronizer RED/GREEN coverage.
- `scripts/test_v2_command_timeline.mjs` — predictionTick → commandTick → Node consumption alignment.
- `scripts/test_v2_owner_reconciliation.mjs` — entity-scoped reconciliation and replay behavior.
- `scripts/test_v2_remote_interpolation.mjs` — remote snapshot interpolation behavior.
- `scripts/test_v2_network_driving.mjs` — deterministic RTT/jitter driving and collision regression.

### Existing files to modify

- `sources/Game/MultiplayerV2/InputPublisher.js` — sample by physical prediction tick, serialize server command tick, track send timestamps.
- `sources/Game/MultiplayerV2/PredictionWorld.js` — retain/predict only local owner after full sync; apply local authoritative state without importing remote live motion.
- `sources/Game/MultiplayerV2/Reconciler.js` — entity-scoped local error test and replay by physical prediction tick; stop using whole-world checksum as normal rollback trigger.
- `sources/Game/MultiplayerV2/VehicleVisuals.js` — local owner from prediction; remotes from snapshot buffers.
- `sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js` — integrate synchronizer, owner prediction clock, authoritative snapshot ingestion and remote interpolation timeline.
- `packages/authoritative-physics/src/RoomSimulation.js` — keep late-input coalescing as safety path; expose bounded future/stale queue diagnostics without changing physics timing.
- `authoritative-node/src/Metrics.js` — record future queue lead/stale backlog/late-input diagnostics for benchmark summaries.
- `authoritative-node/src/NodeAuthoritativeRoom.js` — publish queue diagnostics from the benchmark-only path.
- `scripts/authoritative-node-loadtest.mjs` — revised queue gate semantics and new driving diagnostics.
- `scripts/test_authoritative_node_loadtest.mjs` — exact gate regressions.
- `scripts/test_authoritative_reconciliation.mjs` — retain hard-sync/full-sync cases that still apply after entity-scoped refactor.
- `scripts/test_authoritative_lifecycle.mjs` — full-sync/ACTIVE lifecycle with synchronizer integration.
- `package.json` — include every new test in `test:js` and focused test scripts.

---

### Task 1: Add wrap-safe tick arithmetic and `TickSynchronizer`

**Files:**
- Create: `sources/Game/MultiplayerV2/TickMath.js`
- Create: `sources/Game/MultiplayerV2/TickSynchronizer.js`
- Create: `scripts/test_v2_tick_synchronizer.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `tickAdd(tick, delta) -> uint32`
- Produces: `tickDelta(left, right) -> signed int32`, positive when `left` is after `right` within the half-range rule.
- Produces: `tickAfter(left, right) -> boolean`
- Produces: `tickAtOrAfter(left, right) -> boolean`
- Produces: `TickSynchronizer.observeState(serverTick, receivedAtMs)`
- Produces: `TickSynchronizer.recordSent(sequence, commandTick, sentAtMs)`
- Produces: `TickSynchronizer.acknowledge(sequence, processedServerTick, receivedAtMs)`
- Produces: `TickSynchronizer.estimateServerTick(nowMs) -> uint32`
- Produces: `TickSynchronizer.desiredPredictionTick(nowMs) -> uint32`
- Produces: `TickSynchronizer.interpolationTick(nowMs) -> uint32`
- Produces readonly diagnostics: `commandLeadTicks`, `rttMs`, `jitterMs`, `lateAcks`, `clockDiscontinuities`.

- [ ] **Step 1: Write failing wrap-around and synchronizer tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    tickAdd,
    tickAfter,
    tickDelta,
} from '../sources/Game/MultiplayerV2/TickMath.js'
import { TickSynchronizer } from '../sources/Game/MultiplayerV2/TickSynchronizer.js'

test('uint32 tick ordering stays correct across wrap', () =>
{
    assert.equal(tickAdd(0xffffffff, 1), 0)
    assert.equal(tickDelta(1, 0xffffffff), 2)
    assert.equal(tickAfter(1, 0xffffffff), true)
    assert.equal(tickAfter(0xffffffff, 1), false)
})

test('synchronizer predicts ahead with bounded adaptive lead', () =>
{
    const sync = new TickSynchronizer()
    sync.observeState(1000, 1000)
    assert.equal(sync.commandLeadTicks, 8)
    assert.equal(sync.estimateServerTick(1050), 1003)
    assert.equal(sync.desiredPredictionTick(1050), 1011)

    sync.recordSent(7, 1008, 1000)
    sync.acknowledge(7, 1008, 1150)
    assert.ok(sync.rttMs >= 149 && sync.rttMs <= 151)
    assert.ok(sync.commandLeadTicks >= 8)
    assert.ok(sync.commandLeadTicks <= 18)
})

test('stable low RTT decreases lead slowly and never below four', () =>
{
    const sync = new TickSynchronizer({ initialLeadTicks: 12 })
    sync.observeState(500, 0)
    for(let sequence = 1; sequence <= 40; sequence++)
    {
        const sent = sequence * 100
        sync.recordSent(sequence, 500 + sequence, sent)
        sync.acknowledge(sequence, 500 + sequence, sent + 20)
    }
    assert.ok(sync.commandLeadTicks >= 4)
    assert.ok(sync.commandLeadTicks < 12)
})
```

- [ ] **Step 2: Register and run the test to verify RED**

Add `scripts/test_v2_tick_synchronizer.mjs` to `test:js` and add:

```json
"test:v2-tick-sync": "node --test scripts/test_v2_tick_synchronizer.mjs"
```

Run:

```bash
npm run test:v2-tick-sync
```

Expected: FAIL because `TickMath.js` / `TickSynchronizer.js` do not exist.

- [ ] **Step 3: Implement minimal wrap-safe tick helpers**

```js
export function tickAdd(tick, delta)
{
    return (Number(tick) + Number(delta)) >>> 0
}

export function tickDelta(left, right)
{
    return ((Number(left) >>> 0) - (Number(right) >>> 0)) | 0
}

export function tickAfter(left, right)
{
    return tickDelta(left, right) > 0
}

export function tickAtOrAfter(left, right)
{
    return tickDelta(left, right) >= 0
}
```

Use `tickDelta` for all ordering inside the synchronizer. Estimate elapsed server ticks with `Math.floor(elapsedMs / (1000 / 60))`. Maintain RTT and absolute RTT-delta EWMA; convert `0.5 * RTT + jitter + 2 ticks` to a lead clamped to `4..18`. Increase lead immediately when an acknowledged command was processed at/after its command tick with insufficient remaining slack; decrease by at most one tick after a stable acknowledgement window.

- [ ] **Step 4: Run focused test GREEN and full root tests**

```bash
npm run test:v2-tick-sync
npm test
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add sources/Game/MultiplayerV2/TickMath.js \
        sources/Game/MultiplayerV2/TickSynchronizer.js \
        scripts/test_v2_tick_synchronizer.mjs package.json
git commit -m "feat: synchronize v2 prediction to server ticks"
```

---

### Task 2: Map local physical prediction ticks to existing server command ticks

**Files:**
- Create: `sources/Game/MultiplayerV2/PredictionInputHistory.js`
- Create: `scripts/test_v2_command_timeline.mjs`
- Modify: `sources/Game/MultiplayerV2/InputPublisher.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `predictionTick` from `TickSynchronizer` / `AuthoritativeMultiplayer`.
- Produces: `InputPublisher.sample(predictionTick)` with `input.clientTick === predictionTick - 3` using wrap-safe `tickAdd(predictionTick, -3)`.
- Produces callback: `recordPredictionInput({ predictionTick, entityOrder, input })`.
- Produces callback: `onBatchSent(records, sentAtMs)` invoked only after `sendFrame()` returns true.
- Produces: `PredictionInputHistory.push(record)`, `atPredictionTick(tick)`, `afterPredictionTick(tick)`, `acknowledge(nextSequence)`, `clear()`.

- [ ] **Step 1: Write the failing command-mapping integration test**

```js
test('prediction tick P serializes command P-3 and Node consumes it on physical tick P', () =>
{
    const sent = []
    const history = []
    const publisher = new InputPublisher(fakeGameWithThrottle(1), {
        isActive: () => true,
        recordPredictionInput: (record) => history.push(record),
        sendFrame: (frame) => { sent.push(frame); return true },
    })

    const input = publisher.sample(103)
    assert.equal(input.clientTick, 100)
    assert.equal(history[0].predictionTick, 103)
    assert.equal(history[0].input.clientTick, 100)

    const { room, world, entityOrder } = createActiveRoomAtTick(100)
    room.queueInput(entityOrder, input)
    room.advanceOneTick()
    room.advanceOneTick()
    room.advanceOneTick()
    const application = world.inputApplications.find(
        (entry) => entry.input.sequence === input.sequence,
    )
    assert.equal(application.serverTick, 103)
})
```

Also test wrap mapping:

```js
assert.equal(commandTickForPredictionTick(1), 0xfffffffe)
```

- [ ] **Step 2: Run to verify RED**

```bash
node --test scripts/test_v2_command_timeline.mjs
```

Expected: FAIL because `InputPublisher.sample()` still writes the physical local tick directly into `clientTick` and history has no `predictionTick` metadata.

- [ ] **Step 3: Implement `PredictionInputHistory` and update publisher**

Core mapping:

```js
const SERVER_INPUT_BUFFER_TICKS = 3

export function commandTickForPredictionTick(predictionTick)
{
    return tickAdd(predictionTick, -SERVER_INPUT_BUFFER_TICKS)
}

sample(predictionTick)
{
    const commandTick = commandTickForPredictionTick(predictionTick)
    const input = this.isActive()
        ? createQuantizedInputFromPlayer(this.game?.player, commandTick, sequence)
        : safeInput(commandTick, sequence)

    this.recordPredictionInput({
        predictionTick: predictionTick >>> 0,
        entityOrder: this.entityOrder,
        input,
    })
    // existing batching continues
}
```

Do not change the binary codec. Keep maximum batch size six and the three-sample flush cadence.

- [ ] **Step 4: Run focused and protocol tests**

```bash
node --test scripts/test_v2_command_timeline.mjs
node --test packages/authoritative-physics/test/protocol*.test.mjs
npm test
```

Expected: all PASS; protocol byte-layout expectations unchanged.

- [ ] **Step 5: Commit**

```bash
git add sources/Game/MultiplayerV2/InputPublisher.js \
        sources/Game/MultiplayerV2/PredictionInputHistory.js \
        scripts/test_v2_command_timeline.mjs package.json
git commit -m "feat: align v2 command ticks with server buffer"
```

---

### Task 3: Make `PredictionWorld` local-owner only

**Files:**
- Modify: `sources/Game/MultiplayerV2/PredictionWorld.js`
- Modify: `scripts/test_authoritative_prediction_bridge.mjs`
- Create: `scripts/test_v2_owner_prediction_world.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `PredictionWorld.setLocalEntityOrder(entityOrder)`.
- Produces: `PredictionWorld.retainLocalEntity()` removes all non-local dynamic vehicles after full-sync restore while keeping map/static collision.
- Produces: `PredictionWorld.applyLocalAuthoritativeState(state, serverTick)` using existing `AuthoritativeWorld.setVehicleState()`.
- `readState()` after runtime activation contains only the local owner.
- Remote authoritative states are not inserted into local Rapier prediction.

- [ ] **Step 1: Write failing owner-isolation tests**

```js
test('full sync retains only local owner in prediction world', () =>
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.restoreFullSync(fullSyncWithTwoVehicles())
    prediction.setLocalEntityOrder(1)
    prediction.retainLocalEntity()

    assert.deepEqual(
        prediction.readState().map((state) => state.entityOrder),
        [ 1 ],
    )
})

test('authoritative remote movement does not mutate local prediction world', () =>
{
    const before = prediction.readState(1)
    prediction.applyLocalAuthoritativeState(authoritativeStateForEntity1, 120)
    assert.equal(prediction.tick, 120)
    assert.deepEqual(prediction.readState().map((state) => state.entityOrder), [ 1 ])
    assert.notDeepEqual(prediction.readState(1).position, before.position)
})
```

- [ ] **Step 2: Run to verify RED**

```bash
node --test scripts/test_v2_owner_prediction_world.mjs
```

Expected: FAIL because the local-entity APIs do not exist and current `applyStateFrame()` rebuilds the full authoritative entity set.

- [ ] **Step 3: Implement local-owner isolation without changing shared physics**

After `restoreFullSync(sync)` has reconstructed the exact Rapier snapshot, call:

```js
setLocalEntityOrder(entityOrder)
{
    this.localEntityOrder = entityOrderValue(entityOrder)
}

retainLocalEntity()
{
    for(const order of [ ...this.world.vehicles.keys() ])
    {
        if(order !== this.localEntityOrder)
            this.remove(order)
    }
}
```

`applyLocalAuthoritativeState()` must:

- require the state entity to equal `localEntityOrder`;
- call `this.world.setVehicleState(localEntityOrder, {...})` for position/quaternion/linear/angular velocity/steering/confirmed sequence;
- update local input/runtime metadata from the authoritative state;
- set the PredictionWorld/world tick to the authoritative server tick only as part of an explicit reconciliation restore path, never during ordinary rendering;
- never create a remote body.

- [ ] **Step 4: Run prediction, deterministic physics and root tests**

```bash
node --test scripts/test_v2_owner_prediction_world.mjs
node --test scripts/test_authoritative_prediction_bridge.mjs
node --test packages/authoritative-physics/test/*.test.mjs
npm test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sources/Game/MultiplayerV2/PredictionWorld.js \
        scripts/test_v2_owner_prediction_world.mjs \
        scripts/test_authoritative_prediction_bridge.mjs package.json
git commit -m "refactor: predict only the local v2 owner"
```

---

### Task 4: Replace whole-world rollback with local-owner reconciliation

**Files:**
- Modify: `sources/Game/MultiplayerV2/Reconciler.js`
- Create: `scripts/test_v2_owner_reconciliation.mjs`
- Modify: `scripts/test_authoritative_reconciliation.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PredictionInputHistory` records keyed by `predictionTick`.
- Consumes: authoritative local state from `STATE.states`.
- Produces: reconciliation status `{ status, serverTick, currentTick, rolledBack, replayedTicks, error }`.
- Produces: `localError(predicted, authoritative)` with position/rotation/linear/angular magnitudes.
- Whole-world checksum/world hash remains diagnostic only during normal STATE processing.

- [ ] **Step 1: Write failing entity-scoped reconciliation tests**

```js
test('remote-only authoritative changes do not rollback the local owner', async () =>
{
    const result = await reconciler.reconcileState(frame({
        serverTick: 100,
        local: predictedLocalStateAt100,
        remote: changedRemoteState,
        checksum32: differentWholeWorldChecksum,
    }))
    assert.equal(result.status, 'confirmed')
    assert.equal(result.rolledBack, false)
})

test('local state inside soft tolerances confirms without rollback', async () =>
{
    const result = await reconciler.reconcileState(frameWithLocalOffset({
        positionMeters: 0.02,
        rotationDegrees: 0.4,
        linearVelocity: 0.1,
        angularVelocity: 0.03,
    }))
    assert.equal(result.status, 'confirmed')
    assert.equal(result.rolledBack, false)
})

test('material local error restores authority and replays by predictionTick', async () =>
{
    history.push(recordAtPredictionTick(101, commandTick(98), sequence(10)))
    history.push(recordAtPredictionTick(102, commandTick(99), sequence(11)))

    const result = await reconciler.reconcileState(frameWithLocalOffset({
        serverTick: 100,
        positionMeters: 0.2,
    }))

    assert.equal(result.status, 'rolled-back')
    assert.equal(result.replayedTicks, 2)
    assert.deepEqual(predictionWorld.appliedPredictionTicks, [ 101, 102 ])
})
```

Retain existing tests for missing rollback history, hard-sync recovery and full-sync restore.

- [ ] **Step 2: Run to verify RED**

```bash
node --test scripts/test_v2_owner_reconciliation.mjs scripts/test_authoritative_reconciliation.mjs
```

Expected: remote-only checksum difference still triggers rollback in the old implementation.

- [ ] **Step 3: Implement local error metrics and replay by physical tick**

Use exact initial thresholds:

```js
const SOFT_POSITION_METERS = 0.05
const SOFT_ROTATION_RADIANS = Math.PI / 180
const SOFT_LINEAR_VELOCITY = 0.25
const SOFT_ANGULAR_VELOCITY = 0.10
```

Flow for each STATE:

```js
const authoritativeLocal = frame.states.find(
    (state) => state.entityOrder === this.localEntityOrder,
)
this.acknowledgeFrame(frame)
const predictedLocal = this.predictedLocalStates.get(serverTick)
const error = measureLocalError(predictedLocal, authoritativeLocal)

if(isInsideSoftThresholds(error))
    return confirmedResult(error)

restoreLocalAtServerTick(authoritativeLocal)
replayPredictionTicks(serverTick + 1, currentTick)
return rolledBackResult(error)
```

Do not compare `frame.checksum32` to a local owner-only checksum as a rollback trigger. Preserve the world hash/checksum fields for telemetry and full-sync integrity diagnostics.

- [ ] **Step 4: Run reconciliation and full root test suite**

```bash
node --test scripts/test_v2_owner_reconciliation.mjs scripts/test_authoritative_reconciliation.mjs
npm test
```

Expected: all PASS and remote-only state changes produce zero rollback.

- [ ] **Step 5: Commit**

```bash
git add sources/Game/MultiplayerV2/Reconciler.js \
        scripts/test_v2_owner_reconciliation.mjs \
        scripts/test_authoritative_reconciliation.mjs package.json
git commit -m "feat: reconcile v2 owner state without world rollback"
```

---

### Task 5: Add authoritative remote snapshot interpolation

**Files:**
- Create: `sources/Game/MultiplayerV2/RemoteSnapshotBuffer.js`
- Modify: `sources/Game/MultiplayerV2/VehicleVisuals.js`
- Create: `scripts/test_v2_remote_interpolation.mjs`
- Modify: `scripts/test_authoritative_prediction_bridge.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `RemoteSnapshotBuffer.push(serverTick, state)`.
- Produces: `RemoteSnapshotBuffer.sample(targetTick, fraction = 0) -> state | null`.
- Produces: `RemoteSnapshotBuffer.clear()`.
- `VehicleVisuals.acceptAuthoritativeStateFrame(frame)` stores non-local states only.
- `VehicleVisuals.update(deltaSeconds, interpolationTick)` renders local owner from `PredictionWorld` and remotes from buffers.

- [ ] **Step 1: Write failing interpolation tests**

```js
test('20Hz remote snapshots interpolate smoothly on delayed timeline', () =>
{
    const buffer = new RemoteSnapshotBuffer()
    buffer.push(100, stateAtX(0))
    buffer.push(103, stateAtX(3))

    assert.equal(buffer.sample(101, 0).position[0], 1)
    assert.equal(buffer.sample(102, 0).position[0], 2)
})

test('remote jitter never reverses interpolation time', () =>
{
    const buffer = new RemoteSnapshotBuffer()
    buffer.push(106, stateAtX(6))
    buffer.push(100, stateAtX(0))
    buffer.push(103, stateAtX(3))
    assert.equal(buffer.sample(104, 0).position[0], 4)
})

test('remote interpolation never mutates PredictionWorld', () =>
{
    visuals.acceptAuthoritativeStateFrame(twoRemoteStatesFrame())
    visuals.update(1 / 60, 104)
    assert.deepEqual(predictionWorld.mutations, [])
})
```

- [ ] **Step 2: Run to verify RED**

```bash
node --test scripts/test_v2_remote_interpolation.mjs
```

Expected: FAIL because remotes are currently sourced directly from `predictionWorld.readState()`.

- [ ] **Step 3: Implement bounded snapshot buffers**

Rules:

- keep ordered samples for at most the latest 32 STATE snapshots per entity;
- duplicate tick replaces the older sample;
- interpolate position linearly and quaternion with shortest-path slerp;
- linearly interpolate linear/angular velocity and visual scalar fields;
- extrapolate for at most 3 ticks using velocity only when target is newer than the newest snapshot;
- beyond 3 ticks hold newest sample;
- spawn creates a buffer; despawn destroys that entity's remote and buffer.

Update `VehicleVisuals.update()` so the local branch remains:

```js
const local = this.correction.apply(this.predictionWorld.readState(this.localEntityOrder))
this.physicalVehicle.applyExternalState(local)
```

Remote branches must read only from `RemoteSnapshotBuffer`.

- [ ] **Step 4: Run interpolation, bridge and root tests**

```bash
node --test scripts/test_v2_remote_interpolation.mjs
node --test scripts/test_authoritative_prediction_bridge.mjs
npm test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sources/Game/MultiplayerV2/RemoteSnapshotBuffer.js \
        sources/Game/MultiplayerV2/VehicleVisuals.js \
        scripts/test_v2_remote_interpolation.mjs \
        scripts/test_authoritative_prediction_bridge.mjs package.json
git commit -m "feat: interpolate remote v2 vehicles from snapshots"
```

---

### Task 6: Integrate synchronized owner prediction into `AuthoritativeMultiplayer`

**Files:**
- Modify: `sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js`
- Modify: `scripts/test_authoritative_lifecycle.mjs`
- Modify: `scripts/test_authoritative_network.mjs`
- Create: `scripts/test_v2_prediction_clock.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `TickSynchronizer`, `InputPublisher`, local-owner `PredictionWorld`, entity-scoped `Reconciler`, remote `VehicleVisuals`.
- `STATE.serverTick` is observed immediately on frame receipt.
- `FULL_SYNC.serverTick` seeds the synchronizer and prediction timeline.
- Update loop advances toward `desiredPredictionTick(nowMs)` with existing `MAX_CATCH_UP_TICKS = 3`.
- If already ahead of desired tick, do not simulate another tick; render continues.
- Large clock discontinuity requests full sync instead of teleporting the local prediction clock.

- [ ] **Step 1: Write failing prediction-clock tests**

```js
test('active client predicts to synchronizer target, not free-running browser tick', () =>
{
    synchronizer.desiredPredictionTick = () => 108
    predictionWorld.tick = 105
    multiplayer.update()
    assert.equal(predictionWorld.tick, 108)
})

test('client pauses simulation when already ahead but continues rendering', () =>
{
    synchronizer.desiredPredictionTick = () => 100
    predictionWorld.tick = 102
    multiplayer.update()
    assert.equal(predictionWorld.stepCalls, 0)
    assert.equal(visuals.updateCalls, 1)
})

test('STATE updates synchronizer and remote snapshots before local reconciliation', async () =>
{
    await multiplayer.acceptStateFrame(stateFrameAt(120))
    assert.deepEqual(callOrder, [
        'observe-state-120',
        'accept-remote-snapshots-120',
        'reconcile-local-120',
    ])
})
```

- [ ] **Step 2: Run to verify RED**

```bash
node --test scripts/test_v2_prediction_clock.mjs scripts/test_authoritative_lifecycle.mjs
```

Expected: FAIL because `update()` currently always derives the next tick from `predictionWorld.tick + 1` and free-runs by the browser accumulator.

- [ ] **Step 3: Implement synchronized lifecycle**

Constructor injection:

```js
TickSynchronizerClass = TickSynchronizer
```

On full sync:

```js
this.tickSynchronizer.reset(sync.serverTick, nowMs())
this.predictionWorld.restoreFullSync(sync)
this.predictionWorld.setLocalEntityOrder(this.localEntityOrder)
this.predictionWorld.retainLocalEntity()
```

Then fast-forward only the local owner to the synchronizer's desired prediction tick using recorded/present input. Do not render intermediate fast-forward ticks.

On state:

```js
this.tickSynchronizer.observeState(frame.serverTick, nowMs())
this.visuals.acceptAuthoritativeStateFrame(frame)
await this.reconciler.reconcileState(frame)
```

On each simulated tick `P`, call `inputPublisher.sample(P)` and `reconciler.predict({ predictionTick: P, ... })`.

- [ ] **Step 4: Run lifecycle/network/root tests and production build**

```bash
node --test scripts/test_v2_prediction_clock.mjs \
                scripts/test_authoritative_lifecycle.mjs \
                scripts/test_authoritative_network.mjs
npm test
npm run build
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js \
        scripts/test_v2_prediction_clock.mjs \
        scripts/test_authoritative_lifecycle.mjs \
        scripts/test_authoritative_network.mjs package.json
git commit -m "feat: run v2 owner prediction on server timeline"
```

---

### Task 7: Replace raw queue-zero gate with bounded future-command diagnostics

**Files:**
- Modify: `packages/authoritative-physics/src/RoomSimulation.js`
- Modify: `packages/authoritative-physics/test/roomSimulation.test.mjs`
- Modify: `authoritative-node/src/Metrics.js`
- Modify: `authoritative-node/src/NodeAuthoritativeRoom.js`
- Modify: `authoritative-node/test/metrics.test.mjs`
- Modify: `authoritative-node/test/room.test.mjs`
- Modify: `scripts/authoritative-node-loadtest.mjs`
- Modify: `scripts/test_authoritative_node_loadtest.mjs`

**Interfaces:**
- Produces room diagnostics per tick: `{ futureInputCount, futureLeadMaxTicks, staleInputCount, lateInputCount }`.
- Future input is valid only when its command tick is after the current consumed input tick and lead is bounded.
- Stale queue means an entry remains queued at/before `lastConsumedInputTick`; this must always be zero after tick completion.
- Existing late-input coalescing remains but is measured as a rate.

- [ ] **Step 1: Write failing queue-semantic tests**

```js
test('future commands are bounded health, not persistent backlog', () =>
{
    queueCommandsAhead(room, entityOrder, { from: 100, through: 112 })
    const diagnostics = room.inputQueueDiagnostics()
    assert.ok(diagnostics.futureInputCount > 0)
    assert.ok(diagnostics.futureLeadMaxTicks <= 18)
    assert.equal(diagnostics.staleInputCount, 0)
})

test('hosted gate rejects stale backlog or lead over eighteen ticks', () =>
{
    assert.equal(evaluateHostedGates(summary({ staleInputMax: 1 })).pass, false)
    assert.equal(evaluateHostedGates(summary({ futureLeadMaxTicks: 19 })).pass, false)
    assert.equal(evaluateHostedGates(summary({ futureLeadMaxTicks: 18 })).pass, true)
})
```

- [ ] **Step 2: Run to verify RED**

```bash
node --test packages/authoritative-physics/test/roomSimulation.test.mjs
node --test authoritative-node/test/metrics.test.mjs authoritative-node/test/room.test.mjs
node --test scripts/test_authoritative_node_loadtest.mjs
```

Expected: FAIL because the current metrics expose raw queue depth and existing hosted gates require queue max zero.

- [ ] **Step 3: Implement bounded diagnostics without altering input consumption timing**

Do not change:

```js
const INPUT_BUFFER_TICKS = 3
const inputTick = tick - INPUT_BUFFER_TICKS
```

Add a pure room query that examines queued ticks using wrap-safe tick ordering. At tick completion stale entries must have been removed. Benchmark metrics must retain:

```text
futureInputCountMax
futureLeadMaxTicks
staleInputMax
lateInputCount
lateInputRate
```

Hosted gate rules:

```text
staleInputMax == 0
futureLeadMaxTicks <= 18
persistentFutureQueueGrowth == false
```

Do not fail merely because `futureInputCountMax > 0`.

- [ ] **Step 4: Run Node tests and local hard gate**

```bash
node --test packages/authoritative-physics/test/roomSimulation.test.mjs
npm test --prefix authoritative-node
node --test scripts/test_authoritative_node_loadtest.mjs
npm run benchmark:authoritative-node
```

Expected: tests PASS; local 36,000-tick benchmark stays within existing timing gates under the revised queue semantics.

- [ ] **Step 5: Commit**

```bash
git add packages/authoritative-physics/src/RoomSimulation.js \
        packages/authoritative-physics/test/roomSimulation.test.mjs \
        authoritative-node/src/Metrics.js authoritative-node/src/NodeAuthoritativeRoom.js \
        authoritative-node/test/metrics.test.mjs authoritative-node/test/room.test.mjs \
        scripts/authoritative-node-loadtest.mjs scripts/test_authoritative_node_loadtest.mjs
git commit -m "feat: bound future v2 command queues"
```

---

### Task 8: Add deterministic RTT/jitter driving regression and collision convergence gate

**Files:**
- Create: `scripts/test_v2_network_driving.mjs`
- Modify: `scripts/test_v2_driving_input.mjs`
- Modify: `scripts/test_authoritative_network.mjs`
- Modify: `package.json`

**Interfaces:**
- Network simulator accepts `{ rttMs, jitterMs, dropRate, reorderRate, seed }`.
- Test client exposes metrics: `rollbackCount`, `hardSyncCount`, `lateInputCount`, `maxCommandLeadTicks`, `visualCorrectionCount`.
- Two-client collision scenario returns both clients' final authoritative local/remote states for exact convergence comparison.

- [ ] **Step 1: Write the matrix test before optimizing implementation**

```js
const cases = [
    { rttMs: 20, jitterMs: 0 },
    { rttMs: 60, jitterMs: 10 },
    { rttMs: 100, jitterMs: 10 },
    { rttMs: 150, jitterMs: 30 },
]

for(const network of cases)
{
    test(`sustained owner driving stays smooth at ${network.rttMs}ms RTT`, async () =>
    {
        const result = await runDrivingScenario({
            ...network,
            durationSeconds: 10,
            input: sustainedThrottle(1),
        })

        assert.equal(result.periodicRollbackCadence, false)
        assert.ok(result.rollbackCount <= 1)
        assert.equal(result.hardSyncCount, 0)
        assert.ok(result.maxCommandLeadTicks <= 18)
        assert.ok(result.postWarmupLateInputRate <= 0.01)
        assert.ok(result.horizontalDistance > 5)
    })
}
```

Collision test:

```js
test('two clients converge on the same authoritative head-on collision', async () =>
{
    const result = await runHeadOnCollision({ rttMs: 100, jitterMs: 20 })
    assert.deepEqual(result.clientA.authoritativeFinal, result.serverFinal)
    assert.deepEqual(result.clientB.authoritativeFinal, result.serverFinal)
    assert.equal(result.divergence, false)
})
```

- [ ] **Step 2: Run to verify RED against pre-redesign assumptions**

```bash
node --test scripts/test_v2_network_driving.mjs
```

Expected before all earlier tasks are present: at least one high-latency case fails due late-input/rollback cadence. After Tasks 1-7 this becomes the integrated GREEN target.

- [ ] **Step 3: Add only the instrumentation needed by the assertions**

Expose counters from existing components without changing gameplay behavior:

```js
multiplayer.diagnostics = {
    get commandLeadTicks() { return tickSynchronizer.commandLeadTicks },
    get rollbackCount() { return reconciler.rollbackCount },
    get hardSyncCount() { return reconciler.hardSyncCount },
    get correctionCount() { return visuals.correctionCount },
}
```

Use deterministic seeded delivery scheduling; no wall-clock sleeps in the test.

- [ ] **Step 4: Run network matrix plus all deterministic scenario fixtures**

```bash
node --test scripts/test_v2_network_driving.mjs
node --test packages/authoritative-physics/test/scenarios.test.mjs
npm test
```

Expected: matrix PASS; all existing committed collision checksum/snapshot fixtures remain byte-identical.

- [ ] **Step 5: Commit**

```bash
git add scripts/test_v2_network_driving.mjs \
        scripts/test_v2_driving_input.mjs \
        scripts/test_authoritative_network.mjs package.json
git commit -m "test: gate v2 driving under realistic latency"
```

---

### Task 9: Full verification, production-like driving acceptance, and rollout documentation

**Files:**
- Modify: `.github/workflows/authoritative-node-named-staging.yml` only if new diagnostics must be emitted; keep `workflow_dispatch` only.
- Modify: `docs/multiplayer-v2-rollout.md` if present; otherwise create it.
- Modify: `docs/multiplayer-v2-rollback.md` if present; otherwise create it.
- Modify: PR description with exact evidence; no physics/config tuning.

**Interfaces:**
- Public acceptance reads Node benchmark summary plus client driving diagnostics.
- Production rollback remains Pages `VITE_MULTIPLAYER_PROTOCOL=1` + rebuild.

- [ ] **Step 1: Run complete repository verification on the implementation head**

```bash
node --test packages/authoritative-physics/test/*.test.mjs
npm test
npm run build
npm test --prefix authoritative-node
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
cd multiplayer-worker && npx wrangler deploy --dry-run && cd ..
```

Expected: every command exits 0.

- [ ] **Step 2: Run local production-warmed 36,000-tick Node hard gate**

Run the same command used by `.github/workflows/verify.yml` for the staging production-warmed gate. Record exact commit SHA and summary. Expected:

```text
p95 <= existing threshold
p99 <= existing threshold
max <= 16.67 ms
disconnect = 0
socket error = 0
state gap = 0
staleInputMax = 0
futureLeadMaxTicks <= 18
persistent future queue growth = false
divergence = 0
room restart = 0
overload callback = 0
```

- [ ] **Step 3: Deploy the compatible Node diagnostics build to staging**

On `hk-server` from the exact verified commit:

```bash
git fetch origin
git checkout --detach <verified-commit-sha>
sudo bash ops/authoritative-node/install-staging.sh
sudo systemctl start ch-folio-authoritative-node.service
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS https://hk-test.testnb.me/healthz
```

Do not alter `VITE_MULTIPLAYER_PROTOCOL` during this server-only compatible step.

- [ ] **Step 4: Run named staging 8-client / 600-second benchmark**

Trigger `.github/workflows/authoritative-node-named-staging.yml` manually against the verified commit. Required hard gates include existing performance/determinism checks plus the new bounded future-queue semantics from Task 7.

- [ ] **Step 5: Deploy Pages implementation and run two-browser geographic driving acceptance**

With production v2 enabled, use two geographically separated browsers in the same room and record:

```text
RTT / jitter
command lead ticks
late-input count/rate after warm-up
local rollback count/rate
hard-sync count
correction distance/angle distribution
remote interpolation buffer depth
collision final states
```

Exercise at least:

```text
10 s sustained throttle
10 s sustained steering
brake -> reverse
five stop/start transitions
two-car head-on collision
reconnect after movement
```

Acceptance:

```text
same-frame local input response
no recurring 20 Hz hitch cadence
no periodic rollback in collision-free driving
post-warm-up late-input rate <= 1%
command lead stays 4..18 ticks
stale backlog = 0
no unbounded future queue
no hard sync during normal driving
both clients converge to Node collision outcome
```

- [ ] **Step 6: Document rollout and rollback with exact verified commits**

Rollout document must state:

```text
Node commit deployed
Pages commit deployed
public benchmark run ID
driving acceptance evidence
queue/rollback/late-input metrics
```

Rollback document must retain:

```env
VITE_MULTIPLAYER_PROTOCOL=1
```

and explicitly state that Pages rebuild is required because Vite environment variables are build-time values.

- [ ] **Step 7: Final commit**

```bash
git add docs/ .github/workflows/authoritative-node-named-staging.yml
git commit -m "docs: record server-tick prediction rollout"
```

Only include the workflow file if it actually changed.

---

## Plan Self-Review Results

### Spec coverage

- Explicit server/predicted/interpolation timelines: Tasks 1 and 6.
- Adaptive command lead and RTT/jitter: Task 1.
- Existing protocol-v2 wire layout and three-tick server buffer preserved: Task 2.
- Owner-only prediction: Task 3.
- Entity-scoped local reconciliation and replay by physical prediction tick: Task 4.
- Remote snapshot interpolation: Task 5.
- Synchronized lifecycle/full-sync integration: Task 6.
- Bounded future queue diagnostics replacing raw queue-zero semantics: Task 7.
- 20/60/100/150ms realistic network driving/collision verification: Task 8.
- Local hard gate, public 8-client/600s gate, production driving acceptance and rollback: Task 9.

### Placeholder scan

The plan contains no `TODO`, `TBD`, “implement later”, unspecified error-handling steps, or unnamed test requirements. The `<verified-commit-sha>` shell token in Task 9 is intentionally runtime evidence produced by Step 1, not an unresolved design choice.

### Type/interface consistency

- `predictionTick` always means physical local/server simulation tick.
- `input.clientTick` always means the existing wire command tick consumed three server ticks before the physical execution tick.
- `TickSynchronizer.commandLeadTicks` is always bounded `4..18`.
- Remote state never enters `PredictionWorld` after owner isolation.
- Whole-world checksum/hash is not a routine local rollback trigger after Task 4.
- Full sync remains the only recovery path for missing history/large discontinuity/topology failure.
