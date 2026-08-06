# Node.js Authoritative Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Node.js protocol-v2 authoritative server that reuses the existing deterministic room simulation and browser wire protocol without changing production routing.

**Architecture:** A dedicated `authoritative-node` package hosts a Node HTTP server and a `ws` no-server WebSocket edge. Platform-neutral deterministic simulation remains in `@ch-folio/authoritative-physics`; Node-specific room/session/socket lifecycle lives only in the new package.

**Tech Stack:** Node.js 24, ESM JavaScript, `node:http`, `node:crypto`, `ws`, Node test runner, deterministic Rapier 0.17.3.

## Global Constraints

- Protocol version remains exactly `2`.
- Rapier deterministic version remains exactly `0.17.3`.
- Vehicle physics and map collision versions remain unchanged.
- Maximum room size remains exactly eight sessions.
- Simulation remains fixed at 60 Hz; state broadcast remains 20 Hz.
- Input buffering remains exactly three ticks.
- Disconnect grace remains exactly 180 ticks.
- Resume tokens never appear in URLs or logs.
- Protocol v1, current Worker bindings, and production environment variables remain unchanged.
- No production deployment is part of this plan.

---

### Task 1: Package scaffold and HTTP edge

**Files:**
- Create: `authoritative-node/package.json`
- Create: `authoritative-node/src/config.js`
- Create: `authoritative-node/src/roomName.js`
- Create: `authoritative-node/src/server.js`
- Create: `authoritative-node/src/index.js`
- Create: `authoritative-node/test/server.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/verify.yml`

**Interfaces:**
- Produces: `createAuthoritativeServer(options)` returning `{ start(), stop(), address(), registry }`.
- Produces: `normalizeRoomName(value)` returning a normalized room or `null`.
- Produces: executable `authoritative-node/src/index.js` using `HOST` and `PORT`.

- [ ] Write failing tests for `/healthz`, invalid upgrades, normalized room query, protocol gate, and graceful stop.
- [ ] Run `npm test --prefix authoritative-node` and confirm missing-module failures.
- [ ] Add package metadata with `ws` and file dependencies on the shared package and deterministic Rapier.
- [ ] Implement HTTP server, health JSON, and guarded no-server WebSocket upgrade.
- [ ] Add root scripts and Verify installation/test steps.
- [ ] Run focused tests and commit `feat: scaffold Node authoritative server`.

### Task 2: Session registry and secure resume tokens

**Files:**
- Create: `authoritative-node/src/token.js`
- Create: `authoritative-node/src/SessionRegistry.js`
- Create: `authoritative-node/test/session.test.mjs`

**Interfaces:**
- Produces: `SessionRegistry.createSession`, `resumeSession`, `disconnect`, `expireGrace`, `setState`, `isCurrentController`, `release`.
- Produces: `resumeTokenFromBytes`, `resumeTokenToBytes`, `createResumeToken`, `digestResumeToken`, `constantTimeEqual`.

- [ ] Write failing tests for eight slots, lowest-slot reuse, digest-only storage, token rotation, stale generations, cross-room rejection, and tick-180 expiry.
- [ ] Run the focused test and confirm missing exports.
- [ ] Implement canonical 32-byte base64url tokens using Node Web Crypto globals.
- [ ] Implement the in-memory registry with exact 180-tick grace.
- [ ] Run tests and commit `feat: add Node authoritative session registry`.

### Task 3: Room scheduler and deterministic runtime

**Files:**
- Create: `authoritative-node/src/TickScheduler.js`
- Create: `authoritative-node/src/NodeAuthoritativeRoom.js`
- Create: `authoritative-node/src/RoomRegistry.js`
- Create: `authoritative-node/test/room.test.mjs`

**Interfaces:**
- Produces: `TickScheduler.start()`, `stop()`, and injected clock support.
- Produces: `NodeAuthoritativeRoom.attachSocket(socket)`, `handleMessage`, `handleClose`, `advanceOneTick`, `destroy`, `summary`.
- Produces: `RoomRegistry.getOrCreate(room)`, `deleteIfEmpty(room)`, `stop()`.

- [ ] Write failing deterministic tests for 60 ticks per second, three-tick catch-up cap, lazy world creation, slot cleanup, and registry room isolation.
- [ ] Run focused tests and confirm missing modules.
- [ ] Implement the rational absolute-deadline scheduler.
- [ ] Create the generated map, `AuthoritativeWorld`, and `RoomSimulation` lazily on first session.
- [ ] Stop and destroy the runtime after the final slot expires.
- [ ] Run tests and commit `feat: add Node authoritative room runtime`.

### Task 4: Protocol-v2 socket lifecycle

**Files:**
- Modify: `authoritative-node/src/NodeAuthoritativeRoom.js`
- Modify: `authoritative-node/src/server.js`
- Create: `authoritative-node/test/protocol.test.mjs`

**Interfaces:**
- Consumes all shared protocol-v2 codecs.
- Produces HELLO_REQUIRED, session grant, FULL_SYNC, STATE, controlled ERROR frames.
- Accepts HELLO, RESUME, SYNC_READY, INPUT_BATCH, FULL_SYNC_REQUEST.

- [ ] Write failing real-loopback WebSocket tests for handshake order, spawn, input routing, 20 Hz state frames, FULL_SYNC request, room full, resume rotation, stale socket rejection, and binary-only enforcement.
- [ ] Run focused tests and confirm lifecycle failures.
- [ ] Implement socket attachments and controlled close behavior.
- [ ] Broadcast state every three ticks and attach completed one-second hashes.
- [ ] Add ping/pong heartbeat cleanup without changing game ticks.
- [ ] Run tests and commit `feat: implement Node protocol-v2 room lifecycle`.

### Task 5: Determinism, documentation, and full verification

**Files:**
- Create: `authoritative-node/README.md`
- Create: `authoritative-node/test/determinism.test.mjs`
- Modify: `.github/workflows/verify.yml`

**Interfaces:**
- Reuses the committed eleven-scenario catalog and harness.
- Exposes only local run instructions; no deployment or production switch.

- [ ] Write a failing cross-environment test that executes every committed fixture through the Node room adapter and compares all 20 Hz checksums and 1 Hz snapshot hashes.
- [ ] Implement the minimal deterministic adapter needed by the test.
- [ ] Document environment variables, health endpoint, WebSocket route, protocol constraints, and non-production status.
- [ ] Run `npm ci`, shared tests, root tests, Node package tests, Vite build, Worker tests/check/dry-run.
- [ ] Update the stacked Draft PR with exact RED/GREEN evidence.
- [ ] Commit `docs: document Node authoritative server foundation`.
