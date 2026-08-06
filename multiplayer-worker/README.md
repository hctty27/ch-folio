# CH Folio Multiplayer Worker

Cloudflare Worker and Durable Object backend for the room-based multiplayer implementation.

## Architecture

- `GET /health` returns service status and supported protocol versions `[1, 2]`.
- `GET /health/rapier-v2` verifies deterministic Rapier execution inside `workerd`.
- WebSocket clients connect to `/ws?room=<room-name>`.
- Missing `protocol` and explicit `protocol=1` route to `GAME_ROOM.getByName(room)`.
- Explicit `protocol=2` routes to `AUTHORITATIVE_ROOM.getByName(room)`.
- Any other protocol selector is rejected before entering a Durable Object namespace.

### Protocol v1

`GameRoom` remains the existing MessagePack state-relay Durable Object. It accepts hibernatable WebSockets, sends the existing welcome/join/leave messages, and stores player identity, latest state, sequence number, and rate-limit data in serialized WebSocket attachments.

The v1 route and wire contract are intentionally unchanged:

```text
/ws?room=public
/ws?room=public&protocol=1
```

### Protocol v2

`AuthoritativeGameRoom` is a separate SQLite-backed Durable Object namespace:

```text
/ws?room=public&protocol=2
```

The current server-side protocol-v2 flow is:

1. Accept the WebSocket through the Durable Object Hibernation API.
2. Send a fixed binary `HELLO_REQUIRED` frame.
3. Accept a binary HELLO for a new session or a binary RESUME for a disconnected session.
4. Return a binary session grant containing a random 32-byte resume token.
5. Send a binary FULL_SYNC frame before starting or resuming normal state delivery.
6. Run the authoritative Rapier room at a fixed 60 Hz while at least one slot exists.
7. Broadcast a binary STATE frame every three ticks, producing a 20 Hz network cadence.

The room keeps at most eight stable entity slots. Resume-token digests, session state, connection generations, Rapier state, and the room scheduler remain in active Durable Object memory; gameplay state is not written to SQLite.

A disconnected slot remains reserved for exactly 180 server ticks. A valid RESUME rotates the token and increments the connection generation. When the final slot expires or is released, the scheduler stops and the Rapier world, room simulation, pending hashes, and transient metrics are destroyed.

Both Durable Object classes are declared through Wrangler `exports` with SQLite storage. Do not add a legacy `migrations` section to this configuration.

## Authoritative timing and diagnostics

The protocol-v2 room uses integer logical ticks and never passes elapsed wall-clock time into physics:

- Simulation rate: 60 Hz.
- State broadcast rate: 20 Hz.
- Maximum catch-up work per scheduler callback: three ticks.
- World snapshot/hash cadence: every 60 ticks.
- Metrics summary cadence: every 600 ticks.

At a hash boundary the Worker copies the Rapier snapshot synchronously, then calculates SHA-256 asynchronously. The completed hash is attached to the first later STATE frame, so hashing never changes the physics step size.

Metrics include scheduler overload, catch-up work, queued-input depth, occupied slots, decode/encode/broadcast time, snapshot/checksum time, controller-update time, and total Rapier-step time. The frozen Rapier `0.17.3` build does not expose the newer internal broad-phase, narrow-phase, CCD, and solver timing methods; those methods are probed defensively and reported only when available.

## Requirements

- Node.js 24 or newer.
- A Cloudflare account with Workers enabled.
- Wrangler authenticated with the target account.

## Install

```bash
cd multiplayer-worker
npm install
```

## Local development

```bash
npm run dev
```

The local health endpoint is normally:

```text
http://localhost:8787/health
```

The v1 WebSocket endpoint is normally:

```text
ws://localhost:8787/ws?room=public
```

The v2 authoritative endpoint is normally:

```text
ws://localhost:8787/ws?room=public&protocol=2
```

Run Worker tests and type checking:

```bash
npm test
npm run check
```

`npm run check` runs `wrangler types` before TypeScript so both Durable Object namespace types are generated from `wrangler.jsonc` rather than maintained by hand.

## Deploy

```bash
npm run deploy
```

After deployment, copy the generated Worker hostname into the protocol-v1 frontend environment:

```env
VITE_MULTIPLAYER_ENABLED=1
VITE_SERVER_URL=wss://ch-folio-multiplayer.<account-subdomain>.workers.dev/ws
VITE_MULTIPLAYER_ROOM=public
```

Rebuild and redeploy the Vite frontend after changing any `VITE_*` variable.

The browser does not route production gameplay to protocol v2 yet. The authoritative server loop is implemented, but the protocol-v2 browser transport, prediction, reconciliation, and remote rendering integration are later tasks.

## Smoke test

### Protocol v1

1. Deploy the Worker.
2. Configure and redeploy the frontend.
3. Open the site in two separate browsers or one normal and one private window.
4. Confirm both clients connect to the same room.
5. Drive in one window and confirm the other window displays the remote SU7 smoothly.
6. Refresh one window and confirm its old remote vehicle disappears before the new session joins.
7. Temporarily remove `VITE_MULTIPLAYER_ENABLED` and confirm local single-player driving still works.

### Protocol v2 server

1. Open a WebSocket to `/ws?room=smoke&protocol=2`.
2. Confirm the first server message is a binary `HELLO_REQUIRED` frame.
3. Send a compatible binary HELLO.
4. Confirm the server returns a binary session grant followed by FULL_SYNC.
5. Confirm STATE frames arrive at a 20 Hz logical cadence with monotonically increasing server ticks.
6. Disconnect, reconnect within 180 server ticks using RESUME, and confirm the token rotates.
7. Confirm the previous token is rejected after a successful resume.
8. Confirm `/ws?room=smoke&protocol=3` returns HTTP 400 with supported versions `[1, 2]`.

## Current limits

### Protocol v1

- State upload frequency: 12 Hz.
- Per-client server limit: 30 messages per rolling second.
- Maximum accepted client frame: 4096 bytes.
- Maximum remote snapshot history: 20 states.
- Remote interpolation delay: 100 ms.
- No player-to-player Rapier collision in the MVP.

### Protocol v2

- Maximum eight occupied or grace-period slots per room.
- Fixed 60 Hz authoritative simulation and 20 Hz state delivery.
- Three-tick input-buffer contract exists in the shared room simulation.
- 180-tick resume grace with token rotation and connection-generation takeover.
- No protocol-v2 browser transport, local prediction, reconciliation, or production rendering path yet.
- Active rooms intentionally keep a scheduler callback pending; empty rooms stop the timer and become eligible for hibernation.

## Protocol compatibility

Protocol v1 remains the existing MessagePack state-relay contract. Protocol v2 uses the shared fixed-layout binary codec and exact version tuple:

```text
protocolVersion = 2
vehiclePhysicsVersion = 1
mapCollisionVersion = 1
```

The two protocols use separate Durable Object namespaces so protocol-v2 work cannot silently alter existing v1 rooms.
