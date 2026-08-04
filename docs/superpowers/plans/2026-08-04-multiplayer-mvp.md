# Multiplayer MVP Implementation Plan

**Goal:** Add optional room-based multiplayer with a Cloudflare Durable Object WebSocket backend and smoothly interpolated remote SU7 vehicles.

**Architecture:** Keep local Rapier physics client-authoritative. Publish compact versioned state messages at 12 Hz, validate and broadcast them inside one Durable Object per room, and render remote vehicles from delayed snapshot buffers without remote physics bodies.

**Tech Stack:** JavaScript ES modules, Three.js 0.183, MessagePack, Node.js test runner, Cloudflare Workers TypeScript, Durable Objects WebSocket Hibernation, Wrangler 4.

## Global constraints

- Protocol version: `1`.
- State upload frequency: `12 Hz`.
- Remote interpolation delay: `100 ms`.
- Snapshot history: at most `20` states per remote player.
- Client-message limit: `30 messages/second`.
- Maximum accepted client frame: `4096 bytes`.
- Remote vehicles do not create Rapier bodies.
- Durable Object namespace uses SQLite storage and declarative `exports`.
- Frontend and Worker communicate through MessagePack binary frames.

## Task 1: Frontend protocol and interpolation

**Files:**

- `sources/Game/Multiplayer/protocol.js`
- `sources/Game/Multiplayer/SnapshotBuffer.js`
- `scripts/test_multiplayer.mjs`
- `package.json`

**Status:** Implemented.

- Compact protocol constants and flags.
- Finite-number and quaternion validation.
- Value clamping.
- Stale sequence rejection.
- Bounded snapshots.
- Position/scalar interpolation and shortest-path normalized quaternion interpolation.

## Task 2: Remote vehicle rendering

**Files:**

- `sources/Game/Multiplayer/RemoteVehicle.js`
- `sources/Game/Multiplayer/RemotePlayers.js`

**Status:** Implemented.

- Clone the loaded local visual chassis once `VisualVehicle` is ready.
- Discover SU7 wheel nodes through the existing helper.
- Apply remote position, quaternion, steering, wheel roll and brake-light state.
- Keep the remote car render-only with no Rapier imports or colliders.
- Destroy remote scene nodes on leave or disconnect.

## Task 3: Transport and coordinator

**Files:**

- `sources/Game/Server.js`
- `sources/Game/Multiplayer/Multiplayer.js`
- `sources/index.js`

**Status:** Implemented.

- Room query parameter support.
- Concurrent-connect guard.
- Binary MessagePack and text fallback decoding.
- Exponential reconnect capped at 15 seconds.
- Explicit stop lifecycle.
- Optional startup through Vite environment variables.
- Server-time offset for remote snapshots.
- 12 Hz local state publication.
- Invalid local network state isolation so multiplayer cannot break the game loop.
- Remote-player cleanup on disconnect.

## Task 4: Cloudflare Durable Object backend

**Files:**

- `multiplayer-worker/package.json`
- `multiplayer-worker/tsconfig.json`
- `multiplayer-worker/wrangler.jsonc`
- `multiplayer-worker/src/protocol.ts`
- `multiplayer-worker/src/index.ts`
- `multiplayer-worker/test/protocol.test.ts`

**Status:** Implemented; full dependency-backed verification is delegated to repository CI.

- `GET /health` endpoint.
- `/ws?room=<name>` WebSocket route.
- `GAME_ROOM.getByName(room)` routing.
- `ctx.acceptWebSocket()` Hibernation API.
- Server-assigned `crypto.randomUUID()` player identity.
- Serialized per-socket attachments containing identity, latest state, sequence and rate-limit window.
- Initial room snapshot reconstructed from active socket attachments.
- Server timestamps, finite-number validation, quaternion normalization, sequence ordering, message-size limit and per-socket rate limiting.
- SQLite-backed Durable Object declared with Wrangler `exports`.

## Task 5: Deployment and CI

**Files:**

- `.env.multiplayer.example`
- `multiplayer-worker/README.md`
- `readme.md`
- `.github/workflows/verify.yml`
- `.gitignore`

**Status:** Implemented.

- Worker install, test, type-check, local development and deployment commands.
- Frontend environment configuration.
- Two-browser smoke-test procedure.
- Disabled single-player fallback.
- CI coverage for root tests/build and Worker tests/type generation.

## Verification record

### Executed locally

```bash
node --test scripts/test_multiplayer.mjs
```

Result: 12 tests passed, 0 failed.

```bash
node --check sources/Game/Server.js
node --check sources/Game/Multiplayer/Multiplayer.js
node --check sources/Game/Multiplayer/RemoteVehicle.js
node --check sources/Game/Multiplayer/RemotePlayers.js
node --check sources/index.js
```

Result: all syntax checks exited successfully.

### Pending external environment

The current execution environment cannot download the repository or install Wrangler dependencies. The draft pull request therefore requests these checks from GitHub Actions:

```bash
npm test
npm run build
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
```

## Publication

- Branch: `feat/multiplayer-mvp`
- Draft pull request: `#6`
- Base branch: `main`
- Do not merge until the full CI commands above are confirmed or run manually in a dependency-complete checkout.
