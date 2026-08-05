# Authoritative Multiplayer Physics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current client-authoritative room state broadcast with an optional protocol-v2 server-authoritative Rapier simulation that supports deterministic two-way vehicle collisions for up to eight players while preserving immediate local input through full-room prediction and rollback.

**Architecture:** Keep protocol v1 operational during development. Add a repository-local platform-neutral physics package consumed by the browser and Cloudflare Worker, introduce an `AuthoritativeGameRoom` Durable Object for protocol v2, and add a separate browser `AuthoritativeMultiplayer` coordinator. Cut production rooms over to v2 only after deterministic scenario tests and the ten-minute eight-car benchmark pass.

**Tech Stack:** JavaScript ES modules, Three.js 0.183, `@dimforge/rapier3d` pinned exactly to `0.17.3`, Node.js 24 test runner, Cloudflare Workers TypeScript, Durable Objects WebSocket Hibernation API, Wrangler 4, fixed-layout little-endian binary WebSocket frames.

## Global Constraints

- Maximum room occupancy: `8` slots, including active, syncing, and three-second grace-period players.
- Authoritative and predicted physics: fixed `60 Hz`, exactly `1 / 60` seconds per simulation tick.
- Server input delay: exactly `3` ticks.
- Authoritative state broadcast: `20 Hz`, once every `3` physics ticks.
- Browser checkpoints: `30 Hz`, once every `2` physics ticks, retaining `30` checkpoints.
- Browser input history: `60` ticks.
- Missing input: hold the last input for `6` ticks, then zero throttle and ramp steering to zero and brake to one over the next `6` ticks.
- Vehicle CCD: enabled with `maxCcdSubsteps = 2`.
- Solver configuration: global solver iterations `4`, internal PGS iterations `1`, vehicle additional iterations `2`.
- Vehicle collision shape: one dynamic body with `3–5` ordered convex/cuboid colliders.
- Compatibility tuple: `protocolVersion = 2`, `vehiclePhysicsVersion = 1`, `mapCollisionVersion = 1`.
- Rapier dependency must be the exact same version in the root and Worker lockfiles; no `^` or `~` range.
- Normal `https://ch.testnb.me/` remains single-player and opens no multiplayer WebSocket.
- Existing protocol v1 remains available until the final rollout task.
- No visual smoothing value may be written back into the Rapier world.
- No wall-clock value, random value, unordered object iteration, or platform-dependent trigonometric calculation may affect deterministic physics results.

---

## Planned File Structure

### Shared deterministic package

- `packages/authoritative-physics/package.json` — private package metadata and public exports.
- `packages/authoritative-physics/src/versions.js` — compatibility constants and validation.
- `packages/authoritative-physics/src/input.js` — quantization, dequantization, suspension packing, and missing-input fallback.
- `packages/authoritative-physics/src/protocol.js` — fixed binary frame layouts and codecs.
- `packages/authoritative-physics/src/vehicleConfig.js` — all shared vehicle, collider, wheel, CCD, and solver constants.
- `packages/authoritative-physics/src/map.js` — validation and deterministic construction of the generated map data.
- `packages/authoritative-physics/src/vehicle.js` — deterministic vehicle body/controller construction and per-tick input application.
- `packages/authoritative-physics/src/AuthoritativeWorld.js` — platform-neutral Rapier world owner.
- `packages/authoritative-physics/src/RoomSimulation.js` — ordered players, tick advancement, buffering, spawning, grace periods, and events.
- `packages/authoritative-physics/src/checkpoints.js` — snapshot metadata and bounded histories.
- `packages/authoritative-physics/src/canonicalState.js` — stable float32 state extraction, checksum32, and world hash helpers.
- `packages/authoritative-physics/src/spawnPoints.js` — eight fixed spawn descriptors and safety queries.
- `packages/authoritative-physics/generated/map-v1.json` — generated compact authoritative map.
- `packages/authoritative-physics/test/*.test.mjs` — pure, deterministic, rollback, and scenario tests.

### Browser protocol-v2 client

- `sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js` — lifecycle and message routing.
- `sources/Game/MultiplayerV2/Server.js` — protocol-v2 WebSocket transport.
- `sources/Game/MultiplayerV2/InputPublisher.js` — 60 Hz quantized input capture and batched transmission.
- `sources/Game/MultiplayerV2/PredictionWorld.js` — browser copy of the shared physics world.
- `sources/Game/MultiplayerV2/RollbackHistory.js` — 30 Hz checkpoints and 60-tick input history.
- `sources/Game/MultiplayerV2/Reconciler.js` — authority comparison, rollback, replay, and hard sync.
- `sources/Game/MultiplayerV2/VehicleVisuals.js` — local bridge, remote SU7 clones, and visual correction offsets.
- `sources/Game/MultiplayerV2/SyncOverlay.js` — syncing, safe-spawn waiting, and incompatibility messages.

### Cloudflare protocol-v2 adapter

- `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts` — WebSocket/session adapter around `RoomSimulation`.
- `multiplayer-worker/src/v2/TickScheduler.ts` — drift-aware timer scheduling that never supplies wall time to physics.
- `multiplayer-worker/src/v2/SessionRegistry.ts` — slots, token digests, grace deadlines, and connection generations.
- `multiplayer-worker/src/v2/Metrics.ts` — tick phase timing and benchmark summaries.
- `multiplayer-worker/src/v2/crypto.ts` — resume-token generation, digesting, and constant-time comparison.
- `multiplayer-worker/test/v2/*.test.ts` — Worker adapter, session, scheduler, and protocol tests.

### Tooling and generated data

- `scripts/export-authoritative-map.mjs` — deterministic physical GLB to compact map converter.
- `scripts/benchmark-authoritative-room.mjs` — local eight-car ten-minute benchmark.
- `scripts/test_authoritative_*.mjs` — browser integration and rollout contract tests.
- `.github/workflows/verify.yml` — shared package, browser, Worker, and deterministic replay jobs.

---

### Task 1: Pin Rapier and Establish the Shared Package Boundary

**Files:**
- Create: `packages/authoritative-physics/package.json`
- Create: `packages/authoritative-physics/src/index.js`
- Create: `packages/authoritative-physics/src/versions.js`
- Create: `packages/authoritative-physics/test/versions.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `multiplayer-worker/package.json`
- Modify: `multiplayer-worker/package-lock.json`
- Modify: `multiplayer-worker/tsconfig.json`
- Modify: `.github/workflows/verify.yml`

**Interfaces:**
- Produces: `VERSIONS`, `RAPIER_VERSION`, `assertCompatibility(remote)`.
- Produces package export name: `@ch-folio/authoritative-physics`.

- [ ] **Step 1: Write the failing version contract test**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { RAPIER_VERSION, VERSIONS, assertCompatibility } from '../src/versions.js'

test('authoritative versions are exact and reject mismatches', () =>
{
    assert.equal(RAPIER_VERSION, '0.17.3')
    assert.deepEqual(VERSIONS, {
        protocolVersion: 2,
        vehiclePhysicsVersion: 1,
        mapCollisionVersion: 1,
    })
    assert.doesNotThrow(() => assertCompatibility(VERSIONS))
    assert.throws(
        () => assertCompatibility({ ...VERSIONS, mapCollisionVersion: 2 }),
        /mapCollisionVersion/,
    )
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test packages/authoritative-physics/test/versions.test.mjs
```

Expected: failure because the package and `versions.js` do not exist.

- [ ] **Step 3: Add the package and exact version constants**

```js
export const RAPIER_VERSION = '0.17.3'
export const VERSIONS = Object.freeze({
    protocolVersion: 2,
    vehiclePhysicsVersion: 1,
    mapCollisionVersion: 1,
})

export function assertCompatibility(remote)
{
    for(const key of Object.keys(VERSIONS))
    {
        if(remote?.[key] !== VERSIONS[key])
            throw new Error(`incompatible ${key}`)
    }
}
```

`packages/authoritative-physics/package.json` must export `./src/index.js` and contain no platform-specific dependencies.

- [ ] **Step 4: Pin both Rapier dependencies exactly**

Change root and Worker manifests to:

```json
"@dimforge/rapier3d": "0.17.3"
```

Add the shared package to both projects using a local file dependency:

```json
"@ch-folio/authoritative-physics": "file:../packages/authoritative-physics"
```

Regenerate both lockfiles with npm 10 or newer.

- [ ] **Step 5: Make Worker TypeScript accept the shared JavaScript package**

Set `allowJs: true`, `checkJs: false`, and include `../packages/authoritative-physics/src/**/*.js` in `multiplayer-worker/tsconfig.json`.

- [ ] **Step 6: Run GREEN verification**

```bash
npm install
npm install --prefix multiplayer-worker
node --test packages/authoritative-physics/test/versions.test.mjs
npm run check --prefix multiplayer-worker
npm run build
```

Expected: all commands pass and both lockfiles resolve Rapier `0.17.3`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json multiplayer-worker/package.json multiplayer-worker/package-lock.json multiplayer-worker/tsconfig.json packages/authoritative-physics .github/workflows/verify.yml
git commit -m "build: establish shared authoritative physics package"
```

---

### Task 2: Define Quantized Inputs and Missing-Input Fallback

**Files:**
- Create: `packages/authoritative-physics/src/input.js`
- Create: `packages/authoritative-physics/test/input.test.mjs`

**Interfaces:**
- Produces: `quantizeInput(raw)`, `dequantizeInput(input)`, `packSuspensions(states)`, `unpackSuspensions(bits)`, `resolveInputForTick(history, tick)`.
- `QuantizedInput` fields: `clientTick`, `sequence`, `throttle`, `brake`, `steering`, `suspensions`, `flags`.

- [ ] **Step 1: Write boundary and fallback tests**

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
    assert.ok(Math.abs(dequantizeInput(q).steering - 0.5) < 1 / 32767)
})

test('missing input holds six ticks then brakes deterministically', () =>
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
    assert.equal(resolveMissingInput(last, 22).brake, 255)
    assert.equal(resolveMissingInput(last, 22).steering, 0)
})
```

- [ ] **Step 2: Run RED**

```bash
node --test packages/authoritative-physics/test/input.test.mjs
```

Expected: missing exports.

- [ ] **Step 3: Implement exact integer mappings**

Use these rules:

```js
const throttleToByte = (value) => Math.round((clamp(value, -1, 1) + 1) * 127.5)
const byteToThrottle = (value) => value / 127.5 - 1
const unitToByte = (value) => Math.round(clamp(value, 0, 1) * 255)
const steeringToInt16 = (value) => Math.round(clamp(value, -1, 1) * 32767)
```

Suspension packing uses two bits per wheel: `low = 0`, `mid = 1`, `high = 2`, wheel order front-right, front-left, rear-right, rear-left.

- [ ] **Step 4: Implement fallback only from integer ticks**

For age `<= 6`, clone the last input. For age `7–12`, set throttle to neutral byte `128`, and linearly move steering to `0` and brake to `255` using integer rounding. For age `> 12`, return fully safe input.

- [ ] **Step 5: Run GREEN**

```bash
node --test packages/authoritative-physics/test/input.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add packages/authoritative-physics/src/input.js packages/authoritative-physics/test/input.test.mjs
git commit -m "feat: add deterministic multiplayer input model"
```

---

### Task 3: Implement the Protocol-v2 Fixed Binary Codecs

**Files:**
- Create: `packages/authoritative-physics/src/protocol.js`
- Create: `packages/authoritative-physics/test/protocol.test.mjs`
- Modify: `packages/authoritative-physics/src/index.js`

**Interfaces:**
- Produces: `FRAME_TYPES`, `encodeHello`, `decodeHello`, `encodeInputBatch`, `decodeInputBatch`, `encodeStateFrame`, `decodeStateFrame`, `encodeSyncFrame`, `decodeSyncFrame`.
- Input record size: exactly `18` bytes.
- All multi-byte values: little-endian.

- [ ] **Step 1: Write layout tests with exact offsets**

```js
test('input record uses the published 18-byte layout', () =>
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
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    assert.equal(view.getUint8(0), FRAME_TYPES.INPUT_BATCH)
    assert.equal(view.getUint16(2, true), 2)
    assert.equal(view.getUint32(8, true), 0x01020304)
    assert.equal(view.getUint32(12, true), 0x05060708)
    assert.equal(view.getInt16(18, true), -1234)
    assert.deepEqual(decodeInputBatch(bytes).inputs[0].suspensions, 36)
})
```

- [ ] **Step 2: Run RED**

```bash
node --test packages/authoritative-physics/test/protocol.test.mjs
```

- [ ] **Step 3: Implement frame headers**

Every frame begins with:

```text
offset  size  field
0       1     frameType
1       1     flags
2       2     protocolVersion
4       4     payloadByteLength
```

Reject mismatched protocol versions, truncated frames, extra trailing bytes, counts above eight, and non-finite decoded float32 values.

- [ ] **Step 4: Implement input batches**

After the eight-byte header:

```text
offset  size  field
8       4     clientTick
12      4     sequence
16      1     throttle
17      1     brake
18      2     steering
20      1     suspensionBits
21      1     inputFlags
```

Repeat records and include record count in header flag byte. Limit one frame to at most six inputs so the client can batch 100 ms without unbounded frames.

- [ ] **Step 5: Implement state and sync codecs**

State records must encode stable `entityOrder`, position, quaternion, linear velocity, angular velocity, steering, wheel/suspension state, flags, and last confirmed sequence. Sync frames carry the Rapier snapshot bytes plus JSON-free fixed metadata sections.

- [ ] **Step 6: Run GREEN and fuzz malformed lengths**

```bash
node --test packages/authoritative-physics/test/protocol.test.mjs
```

Add 1,000 seeded malformed-length cases and assert decoding never reads outside the supplied buffer.

- [ ] **Step 7: Commit**

```bash
git add packages/authoritative-physics/src packages/authoritative-physics/test/protocol.test.mjs
git commit -m "feat: define authoritative multiplayer binary protocol"
```

---

### Task 4: Extract the Current Vehicle Tuning into Shared Configuration

**Files:**
- Create: `packages/authoritative-physics/src/vehicleConfig.js`
- Create: `packages/authoritative-physics/src/vehicleInput.js`
- Create: `packages/authoritative-physics/test/vehicleConfig.test.mjs`
- Modify: `sources/Game/Physics/PhysicsVehicle.js`
- Modify: `sources/Game/Player.js`
- Create: `scripts/test_authoritative_vehicle_bridge.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `VEHICLE_CONFIG`, `createVehicleInputFromPlayer(player, tick, sequence)`, `applyVehicleInput(controller, body, input, runtimeState)`.
- Existing single-player handling remains functionally unchanged.

- [ ] **Step 1: Freeze the existing tuning in a failing test**

Assert these current values before refactoring:

```js
assert.equal(VEHICLE_CONFIG.steeringAmplitude, 0.5)
assert.equal(VEHICLE_CONFIG.engineForceAmplitude, 300)
assert.equal(VEHICLE_CONFIG.boostMultiplier, 2)
assert.equal(VEHICLE_CONFIG.topSpeed, 5)
assert.equal(VEHICLE_CONFIG.topSpeedBoost, 40)
assert.equal(VEHICLE_CONFIG.brakeAmplitude, 35)
assert.deepEqual(VEHICLE_CONFIG.wheels.offset, [ 0.90, 0, 0.75 ])
assert.equal(VEHICLE_CONFIG.wheels.radius, 0.4)
assert.equal(VEHICLE_CONFIG.wheels.frictionSlip, 0.9)
assert.equal(VEHICLE_CONFIG.wheels.maxSuspensionForce, 150)
```

Also assert the three existing chassis colliders are represented in fixed array order.

- [ ] **Step 2: Run RED**

```bash
node --test packages/authoritative-physics/test/vehicleConfig.test.mjs
```

- [ ] **Step 3: Create plain-data configuration**

Store vectors as numeric arrays, not Three.js objects. Add `ccdEnabled: true`, `additionalSolverIterations: 2`, and preserve the existing collider dimensions and center of mass.

- [ ] **Step 4: Refactor `PhysicsVehicle` to consume the shared constants**

Replace duplicated constructor constants, collider arrays, wheel offsets, wheel settings, and controller update constants with reads from `VEHICLE_CONFIG`. Do not change ticker priority or current single-player behavior in this task.

- [ ] **Step 5: Add a pure input application helper**

Move engine-force, reverse-brake, idle-brake, steering, suspension, and wheel-force calculations into `applyVehicleInput`. Pass all required state explicitly; do not read `Game`, `Date.now`, or `ticker` inside the shared helper.

- [ ] **Step 6: Verify the browser adapter still calls the same Rapier methods**

`scripts/test_authoritative_vehicle_bridge.mjs` must source-inspect `PhysicsVehicle.js` and assert it imports `VEHICLE_CONFIG` and `applyVehicleInput`, while existing vehicle/wheel tests continue to pass.

- [ ] **Step 7: Run GREEN**

```bash
node --test packages/authoritative-physics/test/vehicleConfig.test.mjs scripts/test_authoritative_vehicle_bridge.mjs
npm test
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add packages/authoritative-physics sources/Game/Physics/PhysicsVehicle.js sources/Game/Player.js scripts/test_authoritative_vehicle_bridge.mjs package.json
git commit -m "refactor: share deterministic vehicle tuning"
```

---

### Task 5: Generate the Versioned Authoritative Collision Map

**Files:**
- Create: `scripts/export-authoritative-map.mjs`
- Create: `packages/authoritative-physics/src/map.js`
- Create: `packages/authoritative-physics/generated/map-v1.json`
- Create: `packages/authoritative-physics/test/map.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadAuthoritativeMap(data)`, returning stable ordered collider descriptors and eight spawn points.
- Generator input: `static/playground/playgroundPhysical.glb` plus the fixed world floor.

- [ ] **Step 1: Write map determinism tests**

```js
test('generated map is stable, versioned, and compact', async () =>
{
    const bytesA = await readFile(mapPath)
    await runExporter()
    const bytesB = await readFile(mapPath)
    assert.deepEqual(bytesB, bytesA)
    const map = JSON.parse(bytesB)
    assert.equal(map.version, 1)
    assert.equal(map.spawnPoints.length, 8)
    assert.ok(bytesB.byteLength <= 512 * 1024)
    assert.deepEqual(
        map.colliders.map((item) => item.id),
        [...map.colliders.map((item) => item.id)].sort(),
    )
})
```

- [ ] **Step 2: Run RED**

```bash
node --test packages/authoritative-physics/test/map.test.mjs
```

- [ ] **Step 3: Implement deterministic GLB traversal**

Use `@gltf-transform/core` `NodeIO`. Build each node path from parent names and sibling index, sort by path, and emit fixed trimeshes or cuboids. Round source numbers to six decimal places before writing JSON.

- [ ] **Step 4: Add the fixed world floor and eight explicit spawn points**

The floor descriptor must match the existing `World.setPhysicalFloor()` cuboid: half-extents `[1000, 1, 1000]`, center `[0, -1.01, 0]`, friction `0.25`, restitution `0`.

Spawn points are stored in the generated source manifest in deterministic index order `0–7`; each has position, quaternion, safety half-extents, and approach radius.

- [ ] **Step 5: Validate map records**

`loadAuthoritativeMap` must reject duplicate IDs, unsorted IDs, invalid shapes, non-finite numbers, a map version other than `1`, or any count exceeding configured limits.

- [ ] **Step 6: Add scripts and verify GREEN**

```json
"prepare:authoritative-map": "node scripts/export-authoritative-map.mjs",
"test:authoritative-map": "node --test packages/authoritative-physics/test/map.test.mjs"
```

Run:

```bash
npm run prepare:authoritative-map
npm run test:authoritative-map
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add scripts/export-authoritative-map.mjs packages/authoritative-physics/generated packages/authoritative-physics/src/map.js packages/authoritative-physics/test/map.test.mjs package.json
git commit -m "feat: generate authoritative collision map"
```

---

### Task 6: Build the Platform-Neutral Rapier Vehicle World

**Files:**
- Create: `packages/authoritative-physics/src/vehicle.js`
- Create: `packages/authoritative-physics/src/AuthoritativeWorld.js`
- Create: `packages/authoritative-physics/test/world.test.mjs`

**Interfaces:**
- Produces: `new AuthoritativeWorld({ RAPIER, mapData })`.
- Methods: `addVehicle(descriptor)`, `removeVehicle(entityOrder)`, `setInput(entityOrder, input)`, `step()`, `readVehicleState(entityOrder)`, `takeSnapshot()`, `restoreSnapshot(bytes, metadata)`, `destroy()`.

- [ ] **Step 1: Write a deterministic two-car construction test**

Create two worlds with identical map data, add entity orders `1` then `2`, apply the same inputs for 120 ticks, and assert identical float32 state arrays and snapshot bytes.

- [ ] **Step 2: Run RED**

```bash
node --test packages/authoritative-physics/test/world.test.mjs
```

- [ ] **Step 3: Construct the world with exact integration parameters**

```js
world.timestep = 1 / 60
world.integrationParameters.maxCcdSubsteps = 2
world.integrationParameters.numSolverIterations = 4
world.integrationParameters.numInternalPgsIterations = 1
```

Create map colliders in sorted map ID order.

- [ ] **Step 4: Construct vehicles in `entityOrder` order**

Use one dynamic rigid body, enable CCD, set additional solver iterations to `2`, attach colliders in `VEHICLE_CONFIG.colliders` order, create the ray-cast vehicle controller, and add four wheels in fixed physical order.

- [ ] **Step 5: Apply inputs and step without Three.js**

Use only plain `{x, y, z}` objects and the shared input helper. Update all vehicles in ascending `entityOrder`, then call `world.step()` exactly once.

- [ ] **Step 6: Run GREEN**

```bash
node --test packages/authoritative-physics/test/world.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add packages/authoritative-physics/src/vehicle.js packages/authoritative-physics/src/AuthoritativeWorld.js packages/authoritative-physics/test/world.test.mjs
git commit -m "feat: add deterministic authoritative Rapier world"
```

---

### Task 7: Add Canonical State, Checkpoints, Checksums, and World Hashes

**Files:**
- Create: `packages/authoritative-physics/src/canonicalState.js`
- Create: `packages/authoritative-physics/src/checkpoints.js`
- Create: `packages/authoritative-physics/test/checkpoints.test.mjs`

**Interfaces:**
- Produces: `readCanonicalState(world)`, `checksum32(float32Bytes)`, `hashWorldSnapshot(bytes)`, `CheckpointRing`, `InputHistory`.

- [ ] **Step 1: Write stable ordering and eviction tests**

Assert canonical records are sorted by `entityOrder`, all physics numbers are reduced to float32 with `Math.fround`, 31 checkpoints evict the oldest to retain 30, and 61 input ticks retain 60.

- [ ] **Step 2: Run RED**

```bash
node --test packages/authoritative-physics/test/checkpoints.test.mjs
```

- [ ] **Step 3: Implement canonical float32 state**

Include position, quaternion, linear velocity, angular velocity, steering, four wheel/suspension values, flags, and last confirmed input sequence. Do not include timestamps, socket IDs, or object handles.

- [ ] **Step 4: Implement checksum and strong hash**

Use a documented 32-bit FNV-1a checksum for every 20 Hz state frame. Use SHA-256 for one-Hz full snapshot hash where `crypto.subtle` exists and a Node `crypto` adapter in tests.

- [ ] **Step 5: Implement snapshot metadata**

Each checkpoint stores `tick`, Rapier bytes, ordered entity descriptors, vehicle runtime metadata, confirmed sequences, and deterministic event cursor.

- [ ] **Step 6: Run GREEN**

```bash
node --test packages/authoritative-physics/test/checkpoints.test.mjs packages/authoritative-physics/test/world.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add packages/authoritative-physics/src/canonicalState.js packages/authoritative-physics/src/checkpoints.js packages/authoritative-physics/test/checkpoints.test.mjs
git commit -m "feat: add authoritative checkpoints and divergence hashes"
```

---

### Task 8: Implement RoomSimulation, Input Delay, Safe Spawns, and Grace Removal

**Files:**
- Create: `packages/authoritative-physics/src/spawnPoints.js`
- Create: `packages/authoritative-physics/src/RoomSimulation.js`
- Create: `packages/authoritative-physics/test/roomSimulation.test.mjs`

**Interfaces:**
- Produces: `RoomSimulation` with `reserveSlot`, `markSyncReady`, `queueInput`, `disconnect`, `resume`, `advanceOneTick`, `readStateFrame`, `createFullSync`.
- Emits deterministic events: `spawn`, `despawn`, `resume`, `hardSyncRequired`.

- [ ] **Step 1: Write state-machine tests**

Cover: ninth slot rejection, syncing players occupying slots without bodies, spawn index scan `0–7`, indefinite wait when occupied, three-tick input delay, late input rejection, three-second grace, resume before expiry, and deterministic despawn after tick `disconnectTick + 180`.

- [ ] **Step 2: Run RED**

```bash
node --test packages/authoritative-physics/test/roomSimulation.test.mjs
```

- [ ] **Step 3: Implement stable slot and entity ordering**

Allocate the lowest free slot. Set `entityOrder = slot + 1`. Never reuse an entity order before the prior entity has been deterministically despawned.

- [ ] **Step 4: Implement input delay**

At simulation tick `S`, consume player input labeled `S - 3`. Reject any arriving input whose target tick is already less than or equal to the last consumed target tick.

- [ ] **Step 5: Implement spawn safety**

At every state-broadcast tick, scan spawn points `0–7`. Use `world.intersectionsWithShape` against vehicle collision groups and a deterministic velocity/approach check. Emit a future `spawn` event for `currentTick + 1` only after all checks pass.

- [ ] **Step 6: Implement disconnect safety input and removal**

On disconnect, replace player input with the shared missing-input fallback and set `graceExpiresTick = currentTick + 180`. Resume cancels expiry; otherwise emit `despawn` exactly at expiry.

- [ ] **Step 7: Run GREEN**

```bash
node --test packages/authoritative-physics/test/roomSimulation.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add packages/authoritative-physics/src/spawnPoints.js packages/authoritative-physics/src/RoomSimulation.js packages/authoritative-physics/test/roomSimulation.test.mjs
git commit -m "feat: add authoritative room simulation state machine"
```

---

### Task 9: Add Protocol-v2 Worker Routing Without Breaking Protocol v1

**Files:**
- Create: `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts`
- Create: `multiplayer-worker/test/v2/routing.test.ts`
- Modify: `multiplayer-worker/src/index.ts`
- Modify: `multiplayer-worker/wrangler.jsonc`
- Modify: `multiplayer-worker/README.md`

**Interfaces:**
- Route: `/ws?room=<name>&protocol=2` to `AUTHORITATIVE_ROOM.getByName(room)`.
- Existing `/ws?room=<name>` remains routed to `GAME_ROOM` protocol v1.

- [ ] **Step 1: Write routing tests**

Assert `protocol=2` selects `AUTHORITATIVE_ROOM`, missing protocol selects `GAME_ROOM`, invalid protocol returns `426` with `unsupported_protocol`, and `/health` reports supported versions `[1, 2]`.

- [ ] **Step 2: Run RED**

```bash
npm test --prefix multiplayer-worker -- --run test/v2/routing.test.ts
```

- [ ] **Step 3: Add the second Durable Object binding**

Declare `AUTHORITATIVE_ROOM` and exported class `AuthoritativeGameRoom` with SQLite storage. Do not migrate or rename the existing `GAME_ROOM` class in this task.

- [ ] **Step 4: Add the route branch**

Normalize the room exactly once in the outer Worker. Reject protocol v2 upgrades whose query or handshake version is invalid.

- [ ] **Step 5: Return a minimal v2 WebSocket response**

The new class accepts hibernatable WebSockets and sends a protocol-v2 `HELLO_REQUIRED` frame; no physics loop starts until a valid HELLO arrives.

- [ ] **Step 6: Run GREEN**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
```

- [ ] **Step 7: Commit**

```bash
git add multiplayer-worker/src multiplayer-worker/test multiplayer-worker/wrangler.jsonc multiplayer-worker/README.md
git commit -m "feat: route authoritative multiplayer protocol v2"
```

---

### Task 10: Implement Resume Tokens and Worker Session Registry

**Files:**
- Create: `multiplayer-worker/src/v2/crypto.ts`
- Create: `multiplayer-worker/src/v2/SessionRegistry.ts`
- Create: `multiplayer-worker/test/v2/session.test.ts`
- Modify: `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts`

**Interfaces:**
- Produces: `createResumeToken()`, `digestResumeToken(token)`, `constantTimeEqual(a, b)`, `SessionRegistry`.
- Session states: `syncing`, `waiting_spawn`, `active`, `grace`.

- [ ] **Step 1: Write token lifecycle tests**

Assert 32-byte random tokens, stored digest only, successful resume rotates the token, old token fails, connection generation increases, and a second active socket cannot control the same player.

- [ ] **Step 2: Run RED**

```bash
npm test --prefix multiplayer-worker -- --run test/v2/session.test.ts
```

- [ ] **Step 3: Implement token crypto**

Use `crypto.getRandomValues(new Uint8Array(32))`, base64url encoding, SHA-256 digest, and an XOR accumulator constant-time comparison over equal-length byte arrays.

- [ ] **Step 4: Implement session registry**

Store player ID, entity order, state, token digest, connection generation, disconnect tick, and latest socket tag. Persist only minimal recovery metadata needed across a Durable Object restart; do not persist Rapier checkpoints as normal gameplay storage.

- [ ] **Step 5: Attach connection identity**

WebSocket attachments contain `playerId`, `entityOrder`, `connectionGeneration`, and handshake state. After a successful resume, update the new attachment and invalidate any older generation.

- [ ] **Step 6: Run GREEN**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
```

- [ ] **Step 7: Commit**

```bash
git add multiplayer-worker/src/v2 multiplayer-worker/test/v2
git commit -m "feat: secure authoritative multiplayer session resume"
```

---

### Task 11: Run the 60 Hz Authoritative Loop and Emit Metrics

**Files:**
- Create: `multiplayer-worker/src/v2/TickScheduler.ts`
- Create: `multiplayer-worker/src/v2/Metrics.ts`
- Create: `multiplayer-worker/test/v2/scheduler.test.ts`
- Modify: `multiplayer-worker/src/v2/AuthoritativeGameRoom.ts`

**Interfaces:**
- Produces: `TickScheduler.start()`, `TickScheduler.stop()`, `TickScheduler.running`.
- Scheduler callback receives no elapsed time; it invokes `simulation.advanceOneTick()` once per logical tick.

- [ ] **Step 1: Write fake-clock scheduler tests**

Verify start idempotence, stop cancellation, 60 scheduled ticks per logical second, no wall-clock value passed into simulation, a maximum of three catch-up ticks per callback, and loop shutdown when the final slot is released.

- [ ] **Step 2: Run RED**

```bash
npm test --prefix multiplayer-worker -- --run test/v2/scheduler.test.ts
```

- [ ] **Step 3: Implement drift-aware scheduling**

Use `performance.now()` only to choose the next callback deadline. Advance integer ticks. When late, run at most three immediate ticks, record overload, and schedule the remainder rather than changing `world.timestep`.

- [ ] **Step 4: Integrate `RoomSimulation`**

Instantiate Rapier and generated map lazily after the first valid slot reservation. Start the scheduler when any slot exists. Stop it and free simulation memory when no slot remains.

- [ ] **Step 5: Broadcast at 20 Hz and hash at 1 Hz**

Every third tick encode one state frame. Every sixtieth tick attach the world snapshot hash. Batch all events for that interval in the same frame.

- [ ] **Step 6: Add phase metrics**

Track input decode, controller update, world step and Rapier timing fields, checkpoint, checksum/hash, encode, broadcast, queue depth, and active slots. Log a compact summary every 600 ticks.

- [ ] **Step 7: Run GREEN**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
```

- [ ] **Step 8: Commit**

```bash
git add multiplayer-worker/src/v2 multiplayer-worker/test/v2
git commit -m "feat: run authoritative physics loop in Durable Objects"
```

---

### Task 12: Add the Browser Protocol-v2 Transport and Input Publisher

**Files:**
- Create: `sources/Game/MultiplayerV2/Server.js`
- Create: `sources/Game/MultiplayerV2/InputPublisher.js`
- Create: `scripts/test_authoritative_transport.mjs`
- Modify: `package.json`

**Interfaces:**
- `Server.start({ url, room, resume })`, `sendFrame(bytes)`, `stop()`.
- Emits `frame`, `connected`, `disconnected`, `error`.
- `InputPublisher.sample(tick)` and `flush()`.

- [ ] **Step 1: Write transport contract tests**

Assert the URL includes `room=<normalized>` and `protocol=2`, the token is never placed in the URL, binary type is `arraybuffer`, reconnect uses the existing capped exponential strategy, and stop clears timers.

- [ ] **Step 2: Run RED**

```bash
node --test scripts/test_authoritative_transport.mjs
```

- [ ] **Step 3: Implement binary-only transport**

Reject string frames for protocol v2. Decode only after validating the eight-byte frame header and maximum frame size.

- [ ] **Step 4: Implement 60 Hz input sampling**

Read `game.player` controls and suspension states, quantize once, save the exact quantized object for local prediction, and queue the same object for network transmission.

- [ ] **Step 5: Batch up to six records per frame**

Flush at least every three ticks and immediately before queue overflow. Keep the latest unacknowledged 60 inputs in history.

- [ ] **Step 6: Run GREEN**

```bash
node --test scripts/test_authoritative_transport.mjs
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add sources/Game/MultiplayerV2/Server.js sources/Game/MultiplayerV2/InputPublisher.js scripts/test_authoritative_transport.mjs package.json
git commit -m "feat: add authoritative browser transport and input batching"
```

---

### Task 13: Integrate the Browser Prediction World Without Polluting Single Player

**Files:**
- Create: `sources/Game/MultiplayerV2/PredictionWorld.js`
- Create: `sources/Game/MultiplayerV2/VehicleVisuals.js`
- Modify: `sources/Game/Physics/PhysicsVehicle.js`
- Modify: `sources/Game/Multiplayer/RemoteVehicle.js`
- Create: `scripts/test_authoritative_prediction_bridge.mjs`

**Interfaces:**
- `PhysicsVehicle.setExternalSimulation(active)`.
- `PhysicsVehicle.applyExternalState(state)` mirrors local authoritative/predicted values for camera, audio, and existing visual consumers.
- `PredictionWorld` wraps shared `AuthoritativeWorld`.

- [ ] **Step 1: Write isolation tests**

Assert single-player still owns and steps the original `game.physics.world`; protocol-v2 mode disables the original local chassis body and controller updates; remote protocol-v2 vehicles are visual only; and no generated visual offset reaches Rapier.

- [ ] **Step 2: Run RED**

```bash
node --test scripts/test_authoritative_prediction_bridge.mjs
```

- [ ] **Step 3: Add external simulation mode to `PhysicsVehicle`**

When active, disable the original chassis body/colliders, skip `updatePrePhysics`, and mirror position, quaternion, velocity, forward speed, wheel contact/state, and suspension values from the prediction entity during `updatePostPhysics`.

- [ ] **Step 4: Create the prediction world**

Load the same generated map, create all vehicles in server `entityOrder`, step exactly once per local 60 Hz tick, and expose state for rendering.

- [ ] **Step 5: Adapt vehicle visuals**

The local existing `VisualVehicle` follows `PhysicsVehicle.applyExternalState`. Remote SU7 clones follow prediction-world entities rather than the protocol-v1 `SnapshotBuffer`.

- [ ] **Step 6: Verify GREEN**

```bash
node --test scripts/test_authoritative_prediction_bridge.mjs
npm test
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add sources/Game/Physics/PhysicsVehicle.js sources/Game/MultiplayerV2 sources/Game/Multiplayer/RemoteVehicle.js scripts/test_authoritative_prediction_bridge.mjs
git commit -m "feat: integrate full-room browser prediction world"
```

---

### Task 14: Implement Rollback, Replay, Hard Sync, and Visual Correction

**Files:**
- Create: `sources/Game/MultiplayerV2/RollbackHistory.js`
- Create: `sources/Game/MultiplayerV2/Reconciler.js`
- Create: `scripts/test_authoritative_reconciliation.mjs`

**Interfaces:**
- `RollbackHistory.capture(tick, world, metadata)`, `recordInputs(tick, inputs)`, `nearestCheckpoint(tick)`, `prune(confirmedTick)`.
- `Reconciler.applyAuthoritativeFrame(frame, currentPredictionTick)`.

- [ ] **Step 1: Write delayed-network replay tests**

Run a seeded two-car collision, delay state frames by 0–300 ms, and assert the client converges to the authoritative canonical state. Add tests for an authority tick older than 60 ticks, three consecutive checksum mismatches, and one-Hz world-hash mismatch.

- [ ] **Step 2: Run RED**

```bash
node --test scripts/test_authoritative_reconciliation.mjs
```

- [ ] **Step 3: Capture checkpoints every second tick**

Retain exactly 30 complete snapshots and 60 input ticks. Store entity mappings and controller metadata adjacent to snapshot bytes.

- [ ] **Step 4: Implement local rollback**

Restore the nearest checkpoint at or before authority tick `T`, replay to `T`, overwrite the canonical authoritative vehicle states, then replay all inputs to current prediction tick.

- [ ] **Step 5: Implement hard sync**

Request and apply a full sync when `T` is outside history, after three consecutive state checksum failures, or on world-hash mismatch. Disconnect with `physics_incompatible` only when a fresh hard sync still diverges.

- [ ] **Step 6: Implement visual correction tiers**

- `< 0.25 m` and `< 5°`: decay visual offset over `100 ms`.
- `0.25–1.5 m` or `5–25°`: decay over `50 ms`.
- `> 1.5 m`, `> 25°`, or new collision/roll/stack flag: snap visual offset to zero and show replayed state immediately.

- [ ] **Step 7: Run GREEN**

```bash
node --test scripts/test_authoritative_reconciliation.mjs
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add sources/Game/MultiplayerV2/RollbackHistory.js sources/Game/MultiplayerV2/Reconciler.js scripts/test_authoritative_reconciliation.mjs
git commit -m "feat: reconcile authoritative vehicle collisions with rollback"
```

---

### Task 15: Add Join Sync, Safe-Spawn Waiting, and Resume UX

**Files:**
- Create: `sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js`
- Create: `sources/Game/MultiplayerV2/SyncOverlay.js`
- Create: `scripts/test_authoritative_lifecycle.mjs`
- Modify: `sources/index.js`

**Interfaces:**
- `AuthoritativeMultiplayer.start({ room })`, `stop()`, `destroy()`.
- Lifecycle states: `connecting`, `syncing`, `waiting_spawn`, `active`, `reconnecting`, `incompatible`, `stopped`.

- [ ] **Step 1: Write lifecycle tests**

Assert no-room URLs remain single-player, protocol v2 starts only when `VITE_MULTIPLAYER_PROTOCOL=2`, inputs are ignored before active spawn, sync restoration catches up without rendering intermediate ticks, waiting spawn displays the correct message, and resume credentials use `sessionStorage`.

- [ ] **Step 2: Run RED**

```bash
node --test scripts/test_authoritative_lifecycle.mjs
```

- [ ] **Step 3: Implement HELLO and full sync**

Send versions and optional `playerId/resumeToken` in the first binary frame after connection. Apply snapshot, mappings, controller metadata, and queued inputs, fast-forward without rendering, then send `SYNC_READY`.

- [ ] **Step 4: Implement spawn activation**

Create the local entity only from a server `spawn` event at its exact tick. Until then, keep controls sampled for UI only and do not transmit effective driving inputs.

- [ ] **Step 5: Implement resume storage and rotation**

Store `{ room, playerId, resumeToken }` under a room-scoped `sessionStorage` key. Replace it after every successful resume and remove it after explicit stop or incompatible rejection.

- [ ] **Step 6: Select v1 or v2 in `sources/index.js`**

Use `VITE_MULTIPLAYER_PROTOCOL`. Value `1` creates the existing `Multiplayer`; value `2` creates `AuthoritativeMultiplayer`; any other value disables multiplayer. Preserve the valid `?room=` gate.

- [ ] **Step 7: Run GREEN**

```bash
node --test scripts/test_authoritative_lifecycle.mjs
npm test
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add sources/Game/MultiplayerV2 sources/index.js scripts/test_authoritative_lifecycle.mjs
git commit -m "feat: add authoritative multiplayer join and resume lifecycle"
```

---

### Task 16: Add Cross-Platform Determinism, Collision Scenarios, and Network Simulation

**Files:**
- Create: `packages/authoritative-physics/test/fixtures/*.json`
- Create: `packages/authoritative-physics/test/scenarios.test.mjs`
- Create: `multiplayer-worker/test/v2/determinism.test.ts`
- Create: `scripts/test_authoritative_network.mjs`
- Modify: `.github/workflows/verify.yml`
- Modify: `package.json`

**Interfaces:**
- Fixed scenario fixtures contain initial entities, tick-labeled quantized inputs, expected 20 Hz checksums, and expected one-Hz world hashes.

- [ ] **Step 1: Add fixed scenarios**

Create fixtures for low-speed head-on, high-speed head-on, rear-end, side impact, angled squeeze, barrier impact, ramp landing, roof contact, CCD tunneling, occupied spawn, and eight-car pileup.

- [ ] **Step 2: Generate expected hashes once and commit them**

Use a dedicated `UPDATE_EXPECTED=1` command that refuses to run in CI. Normal tests compare against committed values.

- [ ] **Step 3: Run every fixture in three adapters**

Run shared Node world, Worker adapter, and browser prediction adapter for the same number of ticks. Compare every 20 Hz canonical state and every one-Hz snapshot hash.

- [ ] **Step 4: Add seeded network simulation**

Simulate latency `0–300 ms`, jitter, reordering, dropped frames, batched inputs, one-second authority delay, disconnect at collision, resume within 180 ticks, and resume after expiry.

- [ ] **Step 5: Update CI**

Add explicit jobs for shared package tests, root browser contract/build, Worker tests/type check, and deterministic fixture replay. Keep protocol-v1 tests until rollout completes.

- [ ] **Step 6: Run full verification**

```bash
npm test
npm run build
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
node --test packages/authoritative-physics/test/*.test.mjs scripts/test_authoritative_*.mjs
```

Expected: all tests pass with no regenerated expected hashes.

- [ ] **Step 7: Commit**

```bash
git add packages/authoritative-physics/test multiplayer-worker/test/v2 scripts/test_authoritative_network.mjs .github/workflows/verify.yml package.json
git commit -m "test: verify authoritative collisions across adapters"
```

---

### Task 17: Benchmark Durable Objects and Perform the Controlled Rollout

**Files:**
- Create: `scripts/benchmark-authoritative-room.mjs`
- Create: `docs/multiplayer-authoritative-benchmark.md`
- Modify: `multiplayer-worker/README.md`
- Modify: `.env.multiplayer.example`
- Modify: `readme.md`
- Modify: `sources/index.js` only if the benchmark passes and rollout is approved.

**Interfaces:**
- Benchmark outputs JSON with p50/p95/p99/max tick, phase timings, memory observation, state queue depth, disconnect count, and divergence count.

- [ ] **Step 1: Implement the repeatable eight-car benchmark**

Use the committed pileup fixture in a loop for 36,000 ticks, equivalent to ten minutes at 60 Hz. Report controller, broad phase, narrow phase, CCD, solver, snapshot, hash, encode, broadcast, and total durations.

- [ ] **Step 2: Add a local gate**

The benchmark exits non-zero unless:

```text
p95 <= 8 ms
p99 <= 12 ms
max <= 16.67 ms
observed peak memory <= 96 MB
state backlog == 0 after steady state
input queue depth <= 3
unexpected disconnects == 0
persistent divergences == 0
```

- [ ] **Step 3: Deploy the v2 Worker as non-production traffic**

Deploy the Worker with `AUTHORITATIVE_ROOM` enabled while production frontend remains on `VITE_MULTIPLAYER_PROTOCOL=1`. Run two-client and eight-bot smoke tests against a dedicated room prefix.

- [ ] **Step 4: Record Cloudflare metrics and decision**

Write actual dates, Worker version, test room, p50/p95/p99/max, memory observations, disconnects, and the decision `Durable Object accepted` or `Migrate to Node.js`. Cloudflare isolate memory metrics are shared-isolate observations, so document that limitation explicitly.

- [ ] **Step 5: Stop on benchmark failure**

When any hard gate fails, do not switch production. Open a follow-on implementation plan for the Node.js adapter using the same package and protocol; leave protocol v1 active.

- [ ] **Step 6: Switch production only after all gates pass**

Set Pages production variables:

```env
VITE_MULTIPLAYER_ENABLED=1
VITE_MULTIPLAYER_PROTOCOL=2
VITE_SERVER_URL=wss://<authoritative-worker-domain>/ws
```

Rebuild Pages. Verify `/` creates no WebSocket and `/?room=collision-test` connects with `protocol=2`.

- [ ] **Step 7: Complete production acceptance tests**

Use two geographically separate clients for head-on, rear-end, side-impact, flip, reconnect, and safe-spawn tests. Save both clients' final canonical state/checksum logs and confirm equality.

- [ ] **Step 8: Commit documentation and rollout configuration**

```bash
git add scripts/benchmark-authoritative-room.mjs docs/multiplayer-authoritative-benchmark.md multiplayer-worker/README.md .env.multiplayer.example readme.md sources/index.js
git commit -m "docs: record authoritative multiplayer benchmark and rollout"
```

---

## Final Verification Checklist

- [ ] Root and Worker lockfiles resolve exactly Rapier `0.17.3`.
- [ ] Protocol v1 still passes until production v2 cutover.
- [ ] Protocol-v2 codec rejects malformed, oversized, or incompatible frames.
- [ ] Shared world produces identical hashes in Node, Worker, and browser adapters.
- [ ] All eleven fixed collision/spawn scenarios pass.
- [ ] Prediction converges under 0–300 ms simulated latency and packet disorder.
- [ ] Authority older than one second performs hard sync.
- [ ] Three-second resume restores the same vehicle and rotates the token.
- [ ] Resume after expiry creates a new slot and vehicle.
- [ ] No safe spawn causes waiting, not overlap or invulnerability.
- [ ] Plain `/` remains strict single-player.
- [ ] The eight-car ten-minute benchmark passes every hard gate before production v2 is enabled.
