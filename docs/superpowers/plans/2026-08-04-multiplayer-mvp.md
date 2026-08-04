# Multiplayer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional room-based multiplayer with a Cloudflare Durable Object WebSocket backend and smoothly interpolated remote SU7 vehicles.

**Architecture:** Keep local Rapier physics client-authoritative. Publish compact versioned state messages at 12 Hz, validate and broadcast them inside one Durable Object per room, and render remote vehicles from delayed snapshot buffers without remote physics bodies.

**Tech Stack:** JavaScript ES modules, Three.js 0.183, MessagePack, Node.js test runner, Cloudflare Workers TypeScript, Durable Objects WebSocket Hibernation, Wrangler 4.

## Global Constraints

- Multiplayer must not affect local driving when disabled or disconnected.
- Protocol version is exactly `1`.
- State upload frequency is exactly `12 Hz`.
- Remote interpolation delay is exactly `100 ms`.
- Durable Object client-message limit is `30 messages/second`.
- Remote vehicles must not create Rapier bodies or participate in collisions.
- New Durable Object storage is SQLite-backed.
- Frontend and Worker communicate through MessagePack binary frames.

---

### Task 1: Pure frontend protocol and interpolation

**Files:**
- Create: `scripts/test_multiplayer.mjs`
- Create: `sources/Game/Multiplayer/protocol.js`
- Create: `sources/Game/Multiplayer/SnapshotBuffer.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `PROTOCOL_VERSION`, `MESSAGE_TYPES`, `STATE_FLAGS`, `createStateMessage(input)`, `validateStateMessage(message)`.
- Produces: `SnapshotBuffer.add(snapshot)`, `SnapshotBuffer.sample(renderTimestamp)`, `SnapshotBuffer.clear()`.

- [ ] **Step 1: Write failing tests** for protocol constants, finite-number validation, state clamping, stale-sequence rejection, midpoint position interpolation and shortest-path quaternion interpolation.
- [ ] **Step 2: Run** `node --test scripts/test_multiplayer.mjs` and verify failure because the modules do not exist.
- [ ] **Step 3: Implement protocol helpers** with compact keys and no browser-only dependencies.
- [ ] **Step 4: Implement the bounded snapshot buffer** with a maximum of 20 snapshots and 100 ms render delay support.
- [ ] **Step 5: Run** `node --test scripts/test_multiplayer.mjs` and verify all tests pass.
- [ ] **Step 6: Add the multiplayer test to `test:js` and add `test:multiplayer`.**

### Task 2: Remote vehicle rendering

**Files:**
- Create: `sources/Game/Multiplayer/RemoteVehicle.js`
- Create: `sources/Game/Multiplayer/RemotePlayers.js`
- Modify: `scripts/test_multiplayer.mjs`

**Interfaces:**
- `new RemoteVehicle(game, playerId, vehicleTemplate)` exposes `pushState(state)`, `update(now)`, `destroy()`.
- `new RemotePlayers(game)` exposes `upsert(playerId, state)`, `remove(playerId)`, `clear()`, `update(now)`.

- [ ] **Step 1: Add failing source-contract tests** requiring vehicle-template cloning, `discoverSU7WheelNodes`, no Physics/Rapier imports, and explicit destruction.
- [ ] **Step 2: Run the multiplayer test and confirm source-contract failure.**
- [ ] **Step 3: Implement `RemoteVehicle`** to find the cloned chassis, update materials, discover SU7 wheels, apply interpolated transform/steering/wheel roll and brake lights.
- [ ] **Step 4: Implement `RemotePlayers`** as the sole owner of the remote-player map.
- [ ] **Step 5: Run the multiplayer test and confirm it passes.**

### Task 3: Transport and multiplayer coordinator

**Files:**
- Modify: `sources/Game/Server.js`
- Create: `sources/Game/Multiplayer/Multiplayer.js`
- Modify: `sources/index.js`
- Modify: `sources/Game/Game.js`
- Modify: `scripts/test_multiplayer.mjs`

**Interfaces:**
- `Server.start({ room })`, `Server.stop()`, `Server.send(message)`.
- `new Multiplayer(game)` exposes `start()`, `stop()`, `update()`, and `remotePlayers`.
- `game.remoteVehicleTemplate` is captured immediately before `game.world.step(1)`.

- [ ] **Step 1: Add failing tests** requiring optional bootstrap, template capture before local visual construction, 12 Hz publication, room configuration and disconnect cleanup.
- [ ] **Step 2: Run the multiplayer test and confirm failure.**
- [ ] **Step 3: Refactor `Server`** to prevent concurrent connects, support room query parameters, decode binary/text frames, schedule capped reconnects and expose a clean stop lifecycle.
- [ ] **Step 4: Implement `Multiplayer`** to build state messages from `physicalVehicle`, `player`, input actions and the SU7 wheel controller, then route welcome/state/left messages.
- [ ] **Step 5: Capture the pristine vehicle template in `Game` before `world.step(1)`.**
- [ ] **Step 6: Construct multiplayer in `sources/index.js` only when enabled and expose it in public debug mode.
- [ ] **Step 7: Run the multiplayer tests.**

### Task 4: Cloudflare Durable Object backend

**Files:**
- Create: `multiplayer-worker/package.json`
- Create: `multiplayer-worker/tsconfig.json`
- Create: `multiplayer-worker/wrangler.jsonc`
- Create: `multiplayer-worker/src/protocol.ts`
- Create: `multiplayer-worker/src/index.ts`
- Create: `multiplayer-worker/test/protocol.test.ts`

**Interfaces:**
- Worker `GET /health` returns JSON.
- Worker WebSocket route forwards to `env.GAME_ROOM.getByName(room)`.
- `GameRoom.fetch()` upgrades connections.
- `GameRoom.webSocketMessage()`, `webSocketClose()` and `webSocketError()` own room lifecycle.

- [ ] **Step 1: Write failing worker protocol tests** for valid state sanitization, invalid version/type, non-finite numbers, sequence ordering and rate limiting.
- [ ] **Step 2: Run** `npm test --prefix multiplayer-worker` and confirm failure before implementation.
- [ ] **Step 3: Implement Worker protocol helpers** using `@msgpack/msgpack` and typed socket attachments.
- [ ] **Step 4: Implement the Worker entry** with health response, room normalization and upgrade validation.
- [ ] **Step 5: Implement `GameRoom`** with `ctx.acceptWebSocket`, `serializeAttachment`, snapshot reconstruction, server-assigned IDs, sanitization and broadcasts.
- [ ] **Step 6: Configure `wrangler.jsonc`** with `GAME_ROOM`, SQLite-backed `exports`, current compatibility date and observability.
- [ ] **Step 7: Run Worker tests, TypeScript check and Wrangler dry-run.**

### Task 5: Deployment and environment documentation

**Files:**
- Create: `multiplayer-worker/README.md`
- Create: `.env.multiplayer.example`
- Modify: `readme.md`

- [ ] **Step 1: Document local Worker development and deployment commands.**
- [ ] **Step 2: Document frontend environment variables and Cloudflare Pages rebuild requirements.**
- [ ] **Step 3: Document two-browser smoke testing, disabled fallback and deferred collision behavior.**
- [ ] **Step 4: Add a short Multiplayer section to the repository README.**

### Task 6: Verification and publication

**Files:**
- Verify all files above.

- [ ] **Step 1: Run** `node --test scripts/test_multiplayer.mjs`.
- [ ] **Step 2: Run** `npm test`.
- [ ] **Step 3: Run** `npm run build`.
- [ ] **Step 4: Run** `npm test --prefix multiplayer-worker` and `npm run check --prefix multiplayer-worker`.
- [ ] **Step 5: Review the final diff for protocol parity, no remote physics, bounded queues/buffers, finite-number validation and no hardcoded secrets.**
- [ ] **Step 6: Open a draft pull request from `feat/multiplayer-mvp` to `main` with verification evidence and deployment steps.**
