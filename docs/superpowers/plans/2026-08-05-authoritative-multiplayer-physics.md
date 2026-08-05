# Authoritative Multiplayer Physics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional protocol-v2 server-authoritative Rapier simulation for up to eight players, with deterministic two-way vehicle collisions, full-room client prediction, rollback, hard synchronization, secure short reconnects, and a measured Cloudflare-to-Node migration boundary.

**Architecture:** Keep protocol v1 deployed while v2 is built alongside it. Put deterministic inputs, codecs, vehicle configuration, map construction, physics stepping, checkpoints, and room state in a platform-neutral JavaScript package imported by both Vite and the Worker. Route `protocol=2` sockets to a separate `AuthoritativeGameRoom` Durable Object; the browser selects a separate `AuthoritativeMultiplayer` coordinator only when `VITE_MULTIPLAYER_PROTOCOL=2`. Production changes to v2 only after cross-adapter determinism tests and a deployed ten-minute eight-car load test pass.

**Tech Stack:** JavaScript ES modules, Three.js 0.183, `@dimforge/rapier3d` exactly `0.17.3`, Node.js 24 test runner, Cloudflare Workers TypeScript, Durable Objects WebSocket Hibernation API, Wrangler 4, little-endian fixed-layout binary WebSocket frames.

## Global Constraints

- Room capacity: `8` slots; active, syncing, waiting-spawn, and three-second grace players all consume a slot.
- Physics: fixed `60 Hz`, exactly `1 / 60` seconds; no variable physics timestep.
- Server input buffer: exactly `3` ticks.
- Authoritative state: every `3` ticks (`20 Hz`).
- Browser full checkpoints: every `2` ticks (`30 Hz`), retaining exactly `30`.
- Browser input history: exactly `60` ticks.
- Missing input: hold the last input through age `6`; ages `7–12` use neutral throttle and linearly return steering to zero and brake to full; after age `12` use the fully safe input.
- CCD: vehicle bodies enabled, `maxCcdSubsteps = 2`.
- Solver: global iterations `4`, internal PGS `1`, vehicle additional iterations `2`.
- Vehicle body: one dynamic rigid body with ordered `3–5` cuboid/convex colliders.
- Versions: `protocolVersion = 2`, `vehiclePhysicsVersion = 1`, `mapCollisionVersion = 1`.
- Rapier: root and Worker manifests and lockfiles resolve exactly `0.17.3`; no `^` or `~`.
- Plain `https://ch.testnb.me/` stays single-player and opens no multiplayer socket.
- Existing protocol v1 remains usable until the final cutover.
- Three.js visual correction never mutates Rapier state.
- Deterministic physics never consumes wall-clock time, random values, unordered object traversal, or platform-dependent trigonometric calculations.
- A task is not complete until its focused tests, the existing root tests/build, and relevant Worker checks pass.

---

## File Map

### Shared package

- `packages/authoritative-physics/package.json` — private local package and exports.
- `packages/authoritative-physics/src/versions.js` — versions and compatibility validation.
- `packages/authoritative-physics/src/input.js` — input quantization, suspension packing, and fallback.
- `packages/authoritative-physics/src/protocol.js` — binary frame layouts and codecs.
- `packages/authoritative-physics/src/vehicleConfig.js` — shared tuning, colliders, wheels, CCD, solver values.
- `packages/authoritative-physics/src/vehicleInput.js` — pure per-tick vehicle control calculations.
- `packages/authoritative-physics/src/map.js` — generated-map validation and Rapier collider construction.
- `packages/authoritative-physics/src/vehicle.js` — Rapier vehicle/controller factory.
- `packages/authoritative-physics/src/AuthoritativeWorld.js` — deterministic world owner.
- `packages/authoritative-physics/src/canonicalState.js` — float32 canonical records and checksum.
- `packages/authoritative-physics/src/checkpoints.js` — bounded checkpoints and input histories.
- `packages/authoritative-physics/src/spawnPoints.js` — safe-spawn queries.
- `packages/authoritative-physics/src/RoomSimulation.js` — slots, events, inputs, ticks, grace periods.
- `packages/authoritative-physics/generated/map-v1.json` — compact generated static collision map and eight spawn transforms.
- `packages/authoritative-physics/test/*.test.mjs` — pure and deterministic tests.

### Browser v2

- `sources/Game/MultiplayerV2/Server.js` — protocol-v2 transport.
- `sources/Game/MultiplayerV2/InputPublisher.js` — 60Hz quantized sampling and batching.
- `sources/Game/MultiplayerV2/PredictionWorld.js` — browser shared-world adapter.
- `sources/Game/MultiplayerV2/RollbackHistory.js` — checkpoint/input retention.
- `sources/Game/MultiplayerV2/Reconciler.js` — rollback, replay, hard sync, mismatch policy.
- `sources/Game/MultiplayerV2/VehicleVisuals.js` — local bridge, remote SU7 visuals, correction offsets.
- `sources/Game/MultiplayerV2/SyncOverlay.js` — syncing/waiting/incompatible UI.
- `sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js` — lifecycle and orchestration.

### Worker v2

- `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts` — Durable Object adapter.
- `multiplayer-worker/src/v2/TickScheduler.ts` — drift-aware integer tick scheduler.
- `multiplayer-worker/src/v2/SessionRegistry.ts` — in-memory slot and token state.
- `multiplayer-worker/src/v2/crypto.ts` — token generation/digest/comparison.
- `multiplayer-worker/src/v2/Metrics.ts` — tick-phase metrics and benchmark reporting.
- `multiplayer-worker/test/v2/*.test.ts` — Worker-specific tests.

### Generation, testing, and operations

- `scripts/export-authoritative-map.mjs` — physical GLB and respawn GLB exporter.
- `scripts/test_authoritative_*.mjs` — browser/integration contract tests.
- `scripts/benchmark-authoritative-room.mjs` — local deterministic CPU benchmark.
- `scripts/loadtest-authoritative-worker.mjs` — deployed WebSocket eight-client load test.
- `docs/multiplayer-authoritative-benchmark.md` — measured results and host decision.

---

### Task 1: Pin Rapier and Create the Shared Package

**Files:**
- Create: `packages/authoritative-physics/package.json`
- Create: `packages/authoritative-physics/src/index.js`
- Create: `packages/authoritative-physics/src/versions.js`
- Create: `packages/authoritative-physics/test/versions.test.mjs`
- Modify: `package.json`, `package-lock.json`
- Modify: `multiplayer-worker/package.json`, `multiplayer-worker/package-lock.json`, `multiplayer-worker/tsconfig.json`
- Modify: `.github/workflows/verify.yml`

**Interfaces:**
- Produces `RAPIER_VERSION`, `VERSIONS`, `assertCompatibility(remote)`.
- Package export name: `@ch-folio/authoritative-physics`.

- [ ] **Step 1: Write the failing version test**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { RAPIER_VERSION, VERSIONS, assertCompatibility } from '../src/versions.js'

test('versions are exact and incompatible peers are rejected', () =>
{
    assert.equal(RAPIER_VERSION, '0.17.3')
    assert.deepEqual(VERSIONS, {
        protocolVersion: 2,
        vehiclePhysicsVersion: 1,
        mapCollisionVersion: 1,
    })
    assert.doesNotThrow(() => assertCompatibility(VERSIONS))
    assert.throws(() => assertCompatibility({ ...VERSIONS, protocolVersion: 1 }), /protocolVersion/)
})
```

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/versions.test.mjs
```

Expected: module not found.

- [ ] **Step 3: Implement exact constants**

```js
export const RAPIER_VERSION = '0.17.3'
export const VERSIONS = Object.freeze({
    protocolVersion: 2,
    vehiclePhysicsVersion: 1,
    mapCollisionVersion: 1,
})

export function assertCompatibility(remote)
{
    for(const [ key, expected ] of Object.entries(VERSIONS))
    {
        if(remote?.[key] !== expected)
            throw new Error(`incompatible ${key}: expected ${expected}, received ${remote?.[key]}`)
    }
}
```

- [ ] **Step 4: Add the private local package**

`packages/authoritative-physics/package.json` exports `./src/index.js`, has `type: module`, and has no browser, Worker, or Node-only dependency.

- [ ] **Step 5: Pin dependencies and regenerate locks**

Both root and Worker manifests use:

```json
"@dimforge/rapier3d": "0.17.3",
"@ch-folio/authoritative-physics": "file:../packages/authoritative-physics"
```

Run `npm install` at root and `npm install --prefix multiplayer-worker`.

- [ ] **Step 6: Allow the Worker to type-check shared JavaScript**

Set `allowJs: true`, `checkJs: false`, and include `../packages/authoritative-physics/src/**/*.js` in the Worker TypeScript project.

- [ ] **Step 7: Verify GREEN**

```bash
node --test packages/authoritative-physics/test/versions.test.mjs
npm run check --prefix multiplayer-worker
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add packages/authoritative-physics package.json package-lock.json multiplayer-worker/package.json multiplayer-worker/package-lock.json multiplayer-worker/tsconfig.json .github/workflows/verify.yml
git commit -m "build: establish shared authoritative physics package"
```

---

### Task 2: Prove Rapier Works in the Worker Runtime

**Files:**
- Create: `multiplayer-worker/src/v2/rapierSmoke.ts`
- Create: `multiplayer-worker/test/v2/rapier-smoke.test.ts`
- Modify: `multiplayer-worker/src/index.ts`

**Interfaces:**
- Produces `runRapierSmoke(RAPIER): { y: number, snapshotBytes: number }`.
- Temporary health endpoint: `GET /health/rapier-v2`.

- [ ] **Step 1: Write a failing smoke test**

Create a gravity world, add one dynamic cuboid at `y=2`, step exactly 60 times at `1/60`, take a snapshot, and assert finite final `y` and non-empty bytes.

- [ ] **Step 2: Verify RED**

```bash
npm test --prefix multiplayer-worker -- --run test/v2/rapier-smoke.test.ts
```

- [ ] **Step 3: Implement the smoke function and endpoint**

The endpoint returns only `{ ok, rapierVersion, y, snapshotBytes }`; it creates and frees the world within the request.

- [ ] **Step 4: Verify local Worker bundling**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
cd multiplayer-worker && npx wrangler deploy --dry-run
```

Expected: tests, type generation, TypeScript, and Wrangler WASM bundling succeed. If dry-run fails, stop the phase and revise the design rather than switching Rapier packages silently.

- [ ] **Step 5: Commit**

```bash
git add multiplayer-worker/src multiplayer-worker/test/v2
git commit -m "test: prove Rapier runs in the Worker bundle"
```

---

### Task 3: Implement Quantized Inputs and Deterministic Fallback

**Files:**
- Create: `packages/authoritative-physics/src/input.js`
- Create: `packages/authoritative-physics/test/input.test.mjs`
- Modify: `packages/authoritative-physics/src/index.js`

**Interfaces:**
- Produces `quantizeInput`, `dequantizeInput`, `packSuspensions`, `unpackSuspensions`, `resolveMissingInput`.
- Quantized fields: `clientTick`, `sequence`, `throttle`, `brake`, `steering`, `suspensions`, `flags`.

- [ ] **Step 1: Write quantization and fallback tests**

```js
test('input quantization saturates and round-trips', () =>
{
    const q = quantizeInput({
        clientTick: 12,
        sequence: 9,
        throttle: -1,
        brake: 1,
        steering: 0.5,
        suspensions: [ 'low', 'mid', 'high', 'low' ],
        boosting: true,
        honking: false,
    })
    assert.deepEqual(q, {
        clientTick: 12,
        sequence: 9,
        throttle: 0,
        brake: 255,
        steering: 16384,
        suspensions: 36,
        flags: 1,
    })
})

test('missing input holds six ticks then reaches safe input in six ticks', () =>
{
    const last = quantizeInput({
        clientTick: 10,
        sequence: 10,
        throttle: 1,
        brake: 0,
        steering: 1,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    })
    assert.equal(resolveMissingInput(last, 16).throttle, 255)
    assert.equal(resolveMissingInput(last, 17).throttle, 128)
    assert.equal(resolveMissingInput(last, 22).steering, 0)
    assert.equal(resolveMissingInput(last, 22).brake, 255)
})
```

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/input.test.mjs
```

- [ ] **Step 3: Implement exact mappings**

```js
throttleByte = Math.round((clamp(throttle, -1, 1) + 1) * 127.5)
brakeByte = Math.round(clamp(brake, 0, 1) * 255)
steeringInt16 = Math.round(clamp(steering, -1, 1) * 32767)
```

Neutral throttle is byte `128`. Suspension uses two bits per wheel with `low=0`, `mid=1`, `high=2`, ordered front-right, front-left, rear-right, rear-left.

- [ ] **Step 4: Implement tick-only fallback**

Age `<=6`: clone last input. Ages `7–12`: neutral throttle immediately; use `progress = age - 6` over denominator `6` to integer-ramp steering and brake. Age `>12`: neutral throttle, steering zero, brake 255, low suspensions, flags zero.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test packages/authoritative-physics/test/input.test.mjs
git add packages/authoritative-physics/src packages/authoritative-physics/test/input.test.mjs
git commit -m "feat: add deterministic multiplayer input model"
```

---

### Task 4: Implement Protocol-v2 Binary Codecs

**Files:**
- Create: `packages/authoritative-physics/src/protocol.js`
- Create: `packages/authoritative-physics/test/protocol.test.mjs`
- Modify: `packages/authoritative-physics/src/index.js`

**Interfaces:**
- Produces `FRAME_TYPES`, hello/resume/input/state/sync/error encode/decode functions.
- Frame header: exactly `8` bytes.
- Input record: exactly `14` bytes.
- All multibyte values: little-endian.

- [ ] **Step 1: Write exact layout tests**

```js
test('one input frame is an 8-byte header plus one 14-byte record', () =>
{
    const bytes = encodeInputBatch([{
        clientTick: 0x01020304,
        sequence: 0x05060708,
        throttle: 255,
        brake: 64,
        steering: -1234,
        suspensions: 36,
        flags: 3,
    }])
    assert.equal(bytes.byteLength, 22)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    assert.equal(view.getUint8(0), FRAME_TYPES.INPUT_BATCH)
    assert.equal(view.getUint16(2, true), 2)
    assert.equal(view.getUint32(4, true), 14)
    assert.equal(view.getUint32(8, true), 0x01020304)
    assert.equal(view.getUint32(12, true), 0x05060708)
    assert.equal(view.getInt16(18, true), -1234)
    assert.equal(view.getUint8(20), 36)
    assert.equal(view.getUint8(21), 3)
})
```

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/protocol.test.mjs
```

- [ ] **Step 3: Implement the common header**

```text
0: frameType uint8
1: flags/count uint8
2: protocolVersion uint16 LE
4: payloadByteLength uint32 LE
```

Reject wrong version, payload-length mismatch, trailing bytes, non-finite float32 values, and entity counts above eight.

- [ ] **Step 4: Implement input records**

```text
0 clientTick uint32
4 sequence uint32
8 throttle uint8
9 brake uint8
10 steering int16
12 suspensionBits uint8
13 inputFlags uint8
```

Limit a batch to six records.

- [ ] **Step 5: Implement fixed state records**

Each state record includes `entityOrder`, position, quaternion, linear velocity, angular velocity, steering, packed suspension/wheel state, collision flags, and last confirmed sequence. Frames include `serverTick`, event count, state checksum, and optional `{hashTick, sha256}`.

- [ ] **Step 6: Implement full-sync framing**

Full sync carries snapshot bytes, checkpoint tick, ordered entity descriptors, controller metadata, confirmed sequences, event cursor, and queued inputs after the checkpoint. No JSON text is allowed on the v2 socket.

- [ ] **Step 7: Add malformed-length fuzz tests and verify GREEN**

Run 1,000 seeded buffers through all decoders; every failure must be a controlled exception, never an out-of-bounds read.

```bash
node --test packages/authoritative-physics/test/protocol.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add packages/authoritative-physics/src/protocol.js packages/authoritative-physics/src/index.js packages/authoritative-physics/test/protocol.test.mjs
git commit -m "feat: define authoritative multiplayer binary protocol"
```

---

### Task 5: Extract Current Vehicle Physics into Shared Plain Data

**Files:**
- Create: `packages/authoritative-physics/src/vehicleConfig.js`
- Create: `packages/authoritative-physics/src/vehicleInput.js`
- Create: `packages/authoritative-physics/test/vehicleConfig.test.mjs`
- Modify: `sources/Game/Physics/PhysicsVehicle.js`
- Modify: `sources/Game/Player.js`
- Create: `scripts/test_authoritative_vehicle_bridge.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `VEHICLE_CONFIG`, `createQuantizedInputFromPlayer(player, tick, sequence)`, `applyVehicleInput(controller, body, quantizedInput, runtimeState)`.

- [ ] **Step 1: Freeze current tuning in a failing test**

Assert steering `0.5`, engine force `300`, boost multiplier `2`, speeds `5/40`, brake `35`, idle/reverse brake `0.06/0.4`, wheel offset `[0.90,0,0.75]`, radius `0.4`, friction slip `0.9`, max suspension force `150`, travel `2`, side stiffness `3`, compression `10`, relaxation `2.7`, stiffness `25`, and the existing three chassis colliders in current order.

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/vehicleConfig.test.mjs
```

- [ ] **Step 3: Add plain immutable configuration**

Use numeric arrays/objects only. Add `ccdEnabled: true`, `maxCcdSubsteps: 2`, `additionalSolverIterations: 2`. Do not import Three.js.

- [ ] **Step 4: Move control calculations into a pure helper**

The helper receives fixed `dt=1/60`, quantized input, current scalar speed/direction state, and optional deterministic surface friction. It sets wheel steering, brake, engine force, suspension rest length/stiffness, and calls `controller.updateVehicle(1/60)`.

- [ ] **Step 5: Refactor the current single-player adapter**

`PhysicsVehicle` imports the shared values/helper, converts arrays to Three/Rapier values at the boundary, and keeps existing ticker priorities. `Player` remains the raw input/UI owner but exposes the same fields used by quantization.

- [ ] **Step 6: Verify no single-player behavior contract changed**

```bash
node --test packages/authoritative-physics/test/vehicleConfig.test.mjs scripts/test_authoritative_vehicle_bridge.mjs
npm test
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add packages/authoritative-physics sources/Game/Physics/PhysicsVehicle.js sources/Game/Player.js scripts/test_authoritative_vehicle_bridge.mjs package.json
git commit -m "refactor: share deterministic vehicle tuning"
```

---

### Task 6: Generate the Versioned Static Map and Eight Spawns

**Files:**
- Create: `scripts/export-authoritative-map.mjs`
- Create: `packages/authoritative-physics/src/map.js`
- Create: `packages/authoritative-physics/generated/map-v1.json`
- Create: `packages/authoritative-physics/test/map.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Inputs: `static/playground/playgroundPhysical.glb`, `static/respawns/respawnsReferences.glb`, fixed world floor.
- Produces `loadAuthoritativeMap(data)` and a generated map with exactly eight spawn points.

- [ ] **Step 1: Write repeatability and size tests**

Run the exporter twice and assert byte-identical output, map version `1`, exactly eight spawns, sorted unique collider IDs, finite numbers, and output size `<= 512 KiB`.

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/map.test.mjs
```

- [ ] **Step 3: Traverse physical GLB deterministically**

Use `@gltf-transform/core` `NodeIO`. Create a path from ancestor names plus sibling indices, sort paths, transform vertices to world space, round to six decimals, and emit fixed cuboids for box primitives and fixed trimeshes otherwise.

- [ ] **Step 4: Add the existing fixed floor exactly**

Emit half-extents `[1000,1,1000]`, center `[0,-1.01,0]`, friction `0.25`, restitution `0`.

- [ ] **Step 5: Derive eight spawns deterministically**

Read all transforms from `respawnsReferences.glb`, sort by full node path, retain the first eight finite transforms, assign spawn indices `0–7`, and emit position, quaternion, safety half-extents `[2.0,1.5,1.4]`, and approach horizon `0.5` seconds. Fail generation if fewer than eight transforms exist.

- [ ] **Step 6: Validate and expose the map**

Reject duplicate/unsorted IDs, unknown shapes, invalid version, counts beyond limits, non-finite numbers, and a spawn count other than eight.

- [ ] **Step 7: Add commands and verify GREEN**

```json
"prepare:authoritative-map": "node scripts/export-authoritative-map.mjs",
"test:authoritative-map": "node --test packages/authoritative-physics/test/map.test.mjs"
```

```bash
npm run prepare:authoritative-map
npm run test:authoritative-map
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add scripts/export-authoritative-map.mjs packages/authoritative-physics/generated packages/authoritative-physics/src/map.js packages/authoritative-physics/test/map.test.mjs package.json
git commit -m "feat: generate authoritative collision map"
```

---

### Task 7: Build the Platform-Neutral AuthoritativeWorld

**Files:**
- Create: `packages/authoritative-physics/src/vehicle.js`
- Create: `packages/authoritative-physics/src/AuthoritativeWorld.js`
- Create: `packages/authoritative-physics/test/world.test.mjs`

**Interfaces:**
- `new AuthoritativeWorld({ RAPIER, mapData })`.
- Methods: `addVehicle`, `removeVehicle`, `setInput`, `step`, `readVehicleState`, `setVehicleState`, `takeSnapshot`, `restoreSnapshot`, `destroy`.

- [ ] **Step 1: Write a two-world determinism test**

Create two worlds, add entities `1` then `2`, run identical quantized inputs for 120 ticks, and require byte-identical canonical states and Rapier snapshots.

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/world.test.mjs
```

- [ ] **Step 3: Create exact world parameters**

Set gravity `{x:0,y:-9.81,z:0}`, timestep `1/60`, CCD substeps `2`, solver iterations `4`, internal PGS `1`. Construct static colliders in sorted map ID order.

- [ ] **Step 4: Create vehicles deterministically**

Create one dynamic body, enable CCD, set two additional solver iterations, attach colliders in config order, create the ray-cast controller, and add wheels front-right, front-left, rear-right, rear-left.

- [ ] **Step 5: Step in stable entity order**

For each tick, sort active entity orders numerically, apply each quantized input, then call `world.step()` once. Never derive physics state from rendering.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test packages/authoritative-physics/test/world.test.mjs
git add packages/authoritative-physics/src/vehicle.js packages/authoritative-physics/src/AuthoritativeWorld.js packages/authoritative-physics/test/world.test.mjs
git commit -m "feat: add deterministic authoritative Rapier world"
```

---

### Task 8: Add Canonical State, Bounded Histories, and Hashing

**Files:**
- Create: `packages/authoritative-physics/src/canonicalState.js`
- Create: `packages/authoritative-physics/src/checkpoints.js`
- Create: `packages/authoritative-physics/test/checkpoints.test.mjs`

**Interfaces:**
- Produces `readCanonicalState`, `checksum32`, asynchronous `hashWorldSnapshot`, `CheckpointRing`, `InputHistory`.

- [ ] **Step 1: Write ordering/eviction/hash tests**

Require ascending entity order, `Math.fround` for physical numbers, 30-checkpoint retention, 60-input retention, stable FNV-1a checksum32, and stable SHA-256 snapshot digest.

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/checkpoints.test.mjs
```

- [ ] **Step 3: Implement canonical records**

Include entity order, transform, linear/angular velocity, steering, packed wheel/suspension state, collision flags, and confirmed input sequence. Exclude timestamps, handles, sockets, and visual offsets.

- [ ] **Step 4: Implement checkpoint metadata**

Store tick, snapshot bytes, entity descriptors, controller runtime metadata, confirmed sequences, and deterministic event cursor.

- [ ] **Step 5: Implement asynchronous strong hashing safely**

`hashWorldSnapshot(bytes)` returns a Promise. The caller captures bytes synchronously at tick `H`, starts SHA-256 outside the physics step, and later transmits `{hashTick:H, hash}`. Hash completion must never delay or reorder physics ticks.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test packages/authoritative-physics/test/checkpoints.test.mjs packages/authoritative-physics/test/world.test.mjs
git add packages/authoritative-physics/src/canonicalState.js packages/authoritative-physics/src/checkpoints.js packages/authoritative-physics/test/checkpoints.test.mjs
git commit -m "feat: add authoritative checkpoints and divergence hashes"
```

---

### Task 9: Implement RoomSimulation, Safe Spawns, and Grace Periods

**Files:**
- Create: `packages/authoritative-physics/src/spawnPoints.js`
- Create: `packages/authoritative-physics/src/RoomSimulation.js`
- Create: `packages/authoritative-physics/test/roomSimulation.test.mjs`

**Interfaces:**
- Methods: `reserveSlot`, `markSyncReady`, `queueInput`, `disconnect`, `resume`, `advanceOneTick`, `readStateFrame`, `createFullSync`, `release`.
- Events: `spawn`, `despawn`, `resume`, `fullSyncRequested`.

- [ ] **Step 1: Write state-machine tests**

Cover ninth-slot rejection, syncing slot without body, lowest-free slot allocation, scan `0–7`, indefinite waiting, three-tick input consumption, late rejection, 180-tick grace, resume, and deterministic despawn.

- [ ] **Step 2: Verify RED**

```bash
node --test packages/authoritative-physics/test/roomSimulation.test.mjs
```

- [ ] **Step 3: Implement stable slots/entity orders**

Allocate the lowest free slot; `entityOrder = slot + 1`. A slot is reusable only after its despawn event has been applied at the scheduled tick.

- [ ] **Step 4: Implement three-tick input buffering**

At simulation tick `S`, consume target input tick `S-3`. Inputs for a target tick already consumed are rejected and counted.

- [ ] **Step 5: Implement deterministic spawn safety**

Use `intersectionsWithShape` for the inflated vehicle shape. For approach safety, compute each active vehicle's axis-aligned swept bounds from current position to `position + linearVelocity * 0.5`; reject a spawn when those swept bounds intersect the spawn safety AABB. This uses no normalization or trigonometry.

- [ ] **Step 6: Implement disconnect behavior**

Set disconnect tick and `graceExpiresTick = currentTick + 180`; use shared fallback input while the vehicle remains physical. Resume cancels expiry. At expiry emit/apply despawn, then free the slot.

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test packages/authoritative-physics/test/roomSimulation.test.mjs
git add packages/authoritative-physics/src/spawnPoints.js packages/authoritative-physics/src/RoomSimulation.js packages/authoritative-physics/test/roomSimulation.test.mjs
git commit -m "feat: add authoritative room simulation state machine"
```

---

### Task 10: Route Protocol v2 to a Separate Durable Object

**Files:**
- Create: `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts`
- Create: `multiplayer-worker/test/v2/routing.test.ts`
- Modify: `multiplayer-worker/src/index.ts`
- Modify: `multiplayer-worker/wrangler.jsonc`
- Modify: `multiplayer-worker/README.md`

**Interfaces:**
- `/ws?room=<name>&protocol=2` uses `AUTHORITATIVE_ROOM.getByName(room)`.
- Existing `/ws?room=<name>` stays on `GAME_ROOM` v1.

- [ ] **Step 1: Write routing tests**

Require v2 binding selection, v1 fallback, invalid protocol rejection, and `/health` supported versions `[1,2]`.

- [ ] **Step 2: Verify RED**

```bash
npm test --prefix multiplayer-worker -- --run test/v2/routing.test.ts
```

- [ ] **Step 3: Add `AUTHORITATIVE_ROOM` binding/class**

Use a new SQLite-backed Durable Object declaration; do not rename/migrate v1.

- [ ] **Step 4: Add minimal v2 handshake transport**

Accept hibernatable WebSockets and send a binary `HELLO_REQUIRED`; no simulation or slot starts before a valid hello.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
git add multiplayer-worker/src multiplayer-worker/test/v2 multiplayer-worker/wrangler.jsonc multiplayer-worker/README.md
git commit -m "feat: route authoritative multiplayer protocol v2"
```

---

### Task 11: Add Secure In-Memory Sessions and Resume Tokens

**Files:**
- Create: `multiplayer-worker/src/v2/crypto.ts`
- Create: `multiplayer-worker/src/v2/SessionRegistry.ts`
- Create: `multiplayer-worker/test/v2/session.test.ts`
- Modify: `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts`

**Interfaces:**
- Produces `createResumeToken`, `digestResumeToken`, `constantTimeEqual`, `SessionRegistry`.
- States: `syncing`, `waiting_spawn`, `active`, `grace`.

- [ ] **Step 1: Write token/session tests**

Require 32 random bytes, digest-only registry, token rotation, old-token failure, increasing connection generation, one active controller, and grace expiry.

- [ ] **Step 2: Verify RED**

```bash
npm test --prefix multiplayer-worker -- --run test/v2/session.test.ts
```

- [ ] **Step 3: Implement crypto**

Use `crypto.getRandomValues`, base64url, SHA-256, and XOR-accumulator comparison for equal-length digest bytes.

- [ ] **Step 4: Implement the registry as active-room memory**

Store player/entity/state/digest/generation/disconnect tick. Do not persist normal gameplay sessions or Rapier worlds to SQLite. WebSocket attachments store player ID, entity order, generation, and handshake state for the live connection. An actual isolate crash may force a new room; it must not pretend to resume stale physics.

- [ ] **Step 5: Integrate hello/resume**

New session reserves a simulation slot and returns player ID/token. Resume validates room/player/token/grace/current generation, rotates token, increments generation, and invalidates the old socket's authority.

- [ ] **Step 6: Verify GREEN and commit**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
git add multiplayer-worker/src/v2 multiplayer-worker/test/v2
git commit -m "feat: secure authoritative multiplayer session resume"
```

---

### Task 12: Run the Durable Object 60Hz Loop and Metrics

**Files:**
- Create: `multiplayer-worker/src/v2/TickScheduler.ts`
- Create: `multiplayer-worker/src/v2/Metrics.ts`
- Create: `multiplayer-worker/test/v2/scheduler.test.ts`
- Modify: `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts`

**Interfaces:**
- `TickScheduler.start`, `stop`, `running`.
- Callback invokes `simulation.advanceOneTick()`; no elapsed time argument.

- [ ] **Step 1: Write fake-clock tests**

Require idempotent start, cancellation, 60 logical ticks per second, max three catch-up ticks per callback, no variable timestep, and shutdown when no slot remains.

- [ ] **Step 2: Verify RED**

```bash
npm test --prefix multiplayer-worker -- --run test/v2/scheduler.test.ts
```

- [ ] **Step 3: Implement scheduling**

Use `performance.now()` only for callback deadlines. Advance integer ticks. Cap immediate catch-up at three and record overload; never enlarge `world.timestep`.

- [ ] **Step 4: Lazily own the simulation**

Initialize Rapier/map after first valid slot, start while any slot exists, and stop/free world/history when the final slot releases. A running timer intentionally prevents hibernation; an empty v2 room has no timer and may hibernate/evict.

- [ ] **Step 5: Broadcast and hash**

Every third tick encode one state/event frame. Every sixtieth tick synchronously capture snapshot bytes, start asynchronous SHA-256, and attach `{hashTick,hash}` to the first later state frame after completion.

- [ ] **Step 6: Record metrics**

Track decode, controller update, Rapier broad/narrow/CCD/solver timing APIs, snapshot, checksum, encode, broadcast, queue depth, catch-up, slots. Summarize every 600 ticks.

- [ ] **Step 7: Verify GREEN and commit**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
git add multiplayer-worker/src/v2 multiplayer-worker/test/v2
git commit -m "feat: run authoritative physics loop in Durable Objects"
```

---

### Task 13: Add Browser v2 Transport and Input Batching

**Files:**
- Create: `sources/Game/MultiplayerV2/Server.js`
- Create: `sources/Game/MultiplayerV2/InputPublisher.js`
- Create: `scripts/test_authoritative_transport.mjs`
- Modify: `package.json`

**Interfaces:**
- `Server.start({url,room,resume})`, `sendFrame`, `stop`; emits `frame/connected/disconnected/error`.
- `InputPublisher.sample(tick)`, `flush()`.

- [ ] **Step 1: Write transport tests**

Require normalized room and `protocol=2` query, no token in URL, `arraybuffer`, binary-only messages, guarded reconnect, capped backoff, timer cleanup.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/test_authoritative_transport.mjs
```

- [ ] **Step 3: Implement v2 transport**

Validate the eight-byte header and configured max frame size before decoding. Reject text frames.

- [ ] **Step 4: Implement 60Hz sampling**

Read `game.player` once, quantize once, put the same object into local prediction history and network queue. Before active spawn, generate neutral/safe input only.

- [ ] **Step 5: Batch at most six inputs**

Flush every three ticks or earlier on capacity. Retain exactly 60 unacknowledged inputs.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test scripts/test_authoritative_transport.mjs
npm run build
git add sources/Game/MultiplayerV2/Server.js sources/Game/MultiplayerV2/InputPublisher.js scripts/test_authoritative_transport.mjs package.json
git commit -m "feat: add authoritative browser transport and input batching"
```

---

### Task 14: Integrate Full-Room Prediction and Visual Bridges

**Files:**
- Create: `sources/Game/MultiplayerV2/PredictionWorld.js`
- Create: `sources/Game/MultiplayerV2/VehicleVisuals.js`
- Modify: `sources/Game/Physics/PhysicsVehicle.js`
- Modify: `sources/Game/Multiplayer/RemoteVehicle.js`
- Create: `scripts/test_authoritative_prediction_bridge.mjs`

**Interfaces:**
- `PhysicsVehicle.setExternalSimulation(active)`.
- `PhysicsVehicle.applyExternalState(state)`.
- `PredictionWorld.add/remove/applyInputs/step/readState/restoreFullSync`.

- [ ] **Step 1: Write isolation tests**

Require single-player unchanged; v2 disables original local body/controller stepping; prediction world uses only generated map and room vehicles; remote v2 cars remain render-only; visual offsets never enter shared state.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/test_authoritative_prediction_bridge.mjs
```

- [ ] **Step 3: Add external simulation mode**

On enable, call `body.setEnabled(false)` and skip current `updatePrePhysics`; on disable, restore body/controller. `applyExternalState` mirrors local transform, speed/direction, wheel contacts, and suspension values for camera/audio/UI consumers.

- [ ] **Step 4: Create prediction world**

Instantiate shared world/map, apply server events by exact tick/entity order, step 60Hz, and expose all entity states.

- [ ] **Step 5: Render vehicles**

Existing local `VisualVehicle` follows mirrored local state. Remote SU7 clones follow predicted entity states; do not use protocol-v1 `SnapshotBuffer` in v2.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test scripts/test_authoritative_prediction_bridge.mjs
npm test
npm run build
git add sources/Game/Physics/PhysicsVehicle.js sources/Game/MultiplayerV2 sources/Game/Multiplayer/RemoteVehicle.js scripts/test_authoritative_prediction_bridge.mjs
git commit -m "feat: integrate full-room browser prediction world"
```

---

### Task 15: Implement Rollback, Hard Sync, and Visual Reconciliation

**Files:**
- Create: `sources/Game/MultiplayerV2/RollbackHistory.js`
- Create: `sources/Game/MultiplayerV2/Reconciler.js`
- Create: `scripts/test_authoritative_reconciliation.mjs`

**Interfaces:**
- `RollbackHistory.capture/recordInputs/nearestCheckpoint/prune`.
- `Reconciler.applyAuthoritativeFrame(frame,currentPredictionTick)`.

- [ ] **Step 1: Write network-delay reconciliation tests**

Use seeded collision logs with 0–300ms authority delay; require convergence. Cover old authority beyond 60 ticks, three checksum mismatches, world-hash mismatch, and hard-sync-still-divergent disconnect.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/test_authoritative_reconciliation.mjs
```

- [ ] **Step 3: Capture histories**

Checkpoint every even tick; retain 30. Record all ordered player inputs each tick; retain 60.

- [ ] **Step 4: Reconcile within window**

Restore nearest checkpoint at/before `T`, replay to `T`, set all authoritative vehicle states, replay to current prediction tick, compute local canonical checksum, then prune confirmed history.

- [ ] **Step 5: Hard sync policy**

Request full sync when authority is older than history, after three consecutive checksum mismatches, or on matching `hashTick` mismatch. After full sync, recompute at the next comparable hash tick; disconnect only if still mismatched.

- [ ] **Step 6: Visual correction tiers**

Small (`<0.25m` and `<5°`) 100ms; medium (`0.25–1.5m` or `5–25°`) 50ms; large/new collision/roll/stack immediate. Keep correction as render transforms only.

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test scripts/test_authoritative_reconciliation.mjs
npm run build
git add sources/Game/MultiplayerV2/RollbackHistory.js sources/Game/MultiplayerV2/Reconciler.js scripts/test_authoritative_reconciliation.mjs
git commit -m "feat: reconcile authoritative collisions with rollback"
```

---

### Task 16: Add Join/Spawn/Resume Lifecycle and v1/v2 Selection

**Files:**
- Create: `sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js`
- Create: `sources/Game/MultiplayerV2/SyncOverlay.js`
- Create: `scripts/test_authoritative_lifecycle.mjs`
- Modify: `sources/index.js`

**Interfaces:**
- States: `connecting`, `syncing`, `waiting_spawn`, `active`, `reconnecting`, `incompatible`, `stopped`.
- `AuthoritativeMultiplayer.start({room})`, `stop`, `destroy`.

- [ ] **Step 1: Write lifecycle tests**

Require no-room single-player, protocol setting gate, version rejection, no effective input before spawn, no-render fast-forward sync, waiting UI, room-scoped `sessionStorage`, token rotation, and explicit-stop credential removal.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/test_authoritative_lifecycle.mjs
```

- [ ] **Step 3: Implement hello/full sync**

First binary frame after connect sends versions and optional resume data. Restore snapshot/mappings/controller metadata/queued inputs, fast-forward without rendering, then send `SYNC_READY`.

- [ ] **Step 4: Implement exact-tick spawn/despawn**

Only server events create/delete prediction entities. Keep waiting indefinitely when no safe spawn. Open driving only after local spawn applied.

- [ ] **Step 5: Implement credential storage**

Key by normalized room; store player ID/token only in `sessionStorage`; replace on rotate; never place token in URL/log; remove on explicit stop or incompatible response.

- [ ] **Step 6: Select coordinator in `sources/index.js`**

`VITE_MULTIPLAYER_PROTOCOL=1` creates existing `Multiplayer`; `=2` creates `AuthoritativeMultiplayer`; other/missing disables multiplayer. Both still require valid URL `room` and `VITE_MULTIPLAYER_ENABLED=1`.

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test scripts/test_authoritative_lifecycle.mjs
npm test
npm run build
git add sources/Game/MultiplayerV2 sources/index.js scripts/test_authoritative_lifecycle.mjs
git commit -m "feat: add authoritative multiplayer lifecycle"
```

---

### Task 17: Add Deterministic Scenarios and Network Simulation

**Files:**
- Create: `packages/authoritative-physics/test/fixtures/*.json`
- Create: `packages/authoritative-physics/test/scenarios.test.mjs`
- Create: `multiplayer-worker/test/v2/determinism.test.ts`
- Create: `scripts/test_authoritative_network.mjs`
- Modify: `.github/workflows/verify.yml`, `package.json`

**Interfaces:**
- Fixtures contain initial entities, tick-labeled quantized inputs, expected 20Hz checksums, and expected 1Hz snapshot hashes.

- [ ] **Step 1: Add eleven fixtures**

Low/high head-on, rear-end, side, angled squeeze, barrier, ramp landing, roof contact, CCD tunneling, occupied spawn, eight-car pileup.

- [ ] **Step 2: Generate expected values explicitly**

Provide `UPDATE_EXPECTED=1 npm run test:authoritative:scenarios`; it must refuse in CI. Commit generated checksums/hashes.

- [ ] **Step 3: Run fixtures in shared Node, Worker adapter, and browser adapter**

Require identical canonical state at every 20Hz sample and identical SHA-256 at matching hash ticks.

- [ ] **Step 4: Add seeded network simulation**

Latency 0–300ms, jitter, reordering, dropped/batched frames, authority older than one second, disconnect during collision, resume before/after 180 ticks.

- [ ] **Step 5: Update CI and verify**

```bash
npm test
npm run build
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
node --test packages/authoritative-physics/test/*.test.mjs scripts/test_authoritative_*.mjs
```

- [ ] **Step 6: Commit**

```bash
git add packages/authoritative-physics/test multiplayer-worker/test/v2 scripts/test_authoritative_network.mjs .github/workflows/verify.yml package.json
git commit -m "test: verify authoritative collisions across adapters"
```

---

### Task 18: Benchmark Locally and Against the Deployed Durable Object

**Files:**
- Create: `scripts/benchmark-authoritative-room.mjs`
- Create: `scripts/loadtest-authoritative-worker.mjs`
- Create: `docs/multiplayer-authoritative-benchmark.md`
- Modify: `multiplayer-worker/README.md`

**Interfaces:**
- Both tools emit machine-readable JSON with p50/p95/p99/max, phase timings, queue depth, disconnects, divergence, and test metadata.

- [ ] **Step 1: Implement local 36,000-tick benchmark**

Loop the eight-car pileup fixture for ten logical minutes and measure controller, Rapier phases, snapshot, checksum/hash capture, codec, and total tick.

- [ ] **Step 2: Enforce local gates**

Exit non-zero unless p95 `<=8ms`, p99 `<=12ms`, max `<=16.67ms`, queue depth `<=3`, persistent divergence `0`.

- [ ] **Step 3: Implement deployed eight-client load test**

Open eight protocol-v2 sockets to a dedicated room, complete sync/spawn, stream deterministic 60Hz input batches for ten minutes, verify 20Hz state continuity/checksums, record disconnects/backlog/overload metrics returned by an authenticated benchmark-summary frame.

- [ ] **Step 4: Run non-production deployment**

Deploy v2 while Pages remains on protocol 1. Run local benchmark, two-real-browser smoke, then deployed load test.

- [ ] **Step 5: Record actual evidence and host decision**

Document date, Worker version, room, region observations, all latency/tick percentiles, Cloudflare isolate memory observation, queue/disconnect/divergence counts, and `Durable Object accepted` or `Migrate to Node.js`. Note that Cloudflare memory metrics represent the isolate, not a single object.

- [ ] **Step 6: Stop on any failed hard gate**

Do not set Pages to v2. Keep protocol 1 active and create a Node-adapter plan using the same package/protocol.

- [ ] **Step 7: Commit benchmark tooling/evidence**

```bash
git add scripts/benchmark-authoritative-room.mjs scripts/loadtest-authoritative-worker.mjs docs/multiplayer-authoritative-benchmark.md multiplayer-worker/README.md
git commit -m "test: benchmark authoritative multiplayer hosting"
```

---

### Task 19: Controlled Production Cutover

**Files:**
- Modify: `.env.multiplayer.example`
- Modify: `readme.md`
- Modify: `multiplayer-worker/README.md`
- Modify: deployment documentation only; runtime code changes require a separate reviewed commit.

- [ ] **Step 1: Require all prior CI and benchmark gates**

Confirm protocol v1 and v2 tests green, deterministic fixtures green, deployed ten-minute test green, and design acceptance scenarios complete.

- [ ] **Step 2: Set Pages production variables**

```env
VITE_MULTIPLAYER_ENABLED=1
VITE_MULTIPLAYER_PROTOCOL=2
VITE_SERVER_URL=wss://<deployed-worker-domain>/ws
```

- [ ] **Step 3: Rebuild Pages and verify routing**

`/` has no WS. `/?room=collision-test` connects to `/ws?room=collision-test&protocol=2`. Different rooms remain isolated.

- [ ] **Step 4: Run geographically separated acceptance**

Two clients perform head-on, rear-end, side, flip, safe-spawn wait, short reconnect, expired reconnect. Save both final canonical states/checksums and require equality.

- [ ] **Step 5: Document rollback**

Rollback is only a Pages environment change back to `VITE_MULTIPLAYER_PROTOCOL=1` followed by rebuild; do not remove v1 Worker code in this release.

- [ ] **Step 6: Commit documentation**

```bash
git add .env.multiplayer.example readme.md multiplayer-worker/README.md
git commit -m "docs: publish authoritative multiplayer rollout"
```

---

## Self-Review Result

- Every design section maps to at least one task.
- No `TODO`, `TBD`, unspecified codec offset, unspecified tick rate, or unspecified retry duration remains.
- Input record size is consistently `14` bytes after the `8`-byte frame header.
- Full-world SHA-256 is asynchronous and tagged with its capture tick; it never blocks the physics step.
- Spawn transforms have a deterministic source: the first eight sorted transforms in `respawnsReferences.glb`.
- Active protocol-v2 gameplay is intentionally in-memory; the plan does not claim crash-persistent physics recovery.
- Both a local CPU benchmark and a deployed eight-WebSocket ten-minute load test are required.
- Protocol v1 remains the rollback path until a later removal release.

## Final Completion Checklist

- [ ] Both lockfiles resolve Rapier `0.17.3` exactly.
- [ ] Wrangler Worker WASM dry-run passes before core implementation proceeds.
- [ ] Protocol codecs reject malformed/oversized/incompatible frames.
- [ ] Node, Worker, and browser adapters match all fixture checksums/hashes.
- [ ] Prediction converges under 0–300ms simulated network conditions.
- [ ] Hard sync handles authority older than 60 ticks and hidden-state mismatch.
- [ ] Safe spawn waits rather than overlapping.
- [ ] Resume within 180 ticks restores and rotates; expiry despawns.
- [ ] Plain `/` stays single-player.
- [ ] Deployed eight-car ten-minute test passes every gate before v2 production cutover.
