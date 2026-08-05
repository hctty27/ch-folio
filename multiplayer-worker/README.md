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

For Task 10 it implements only the isolated binary handshake boundary:

1. Accept the WebSocket through the Durable Object hibernation API.
2. Send a fixed binary `HELLO_REQUIRED` protocol-v2 error frame.
3. Require the first client frame to be a valid binary HELLO carrying the exact protocol, vehicle-physics, and map-collision versions.
4. Record only handshake state in the serialized WebSocket attachment.

No session, player slot, vehicle body, Rapier world, or simulation timer is created during this task. Those responsibilities are added by later authoritative multiplayer tasks.

Both Durable Object classes are declared through Wrangler `exports` with SQLite storage. Do not add a legacy `migrations` section to this configuration.

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

The isolated v2 handshake endpoint is normally:

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

The browser does not route production gameplay to protocol v2 yet. Task 10 only establishes the separate server-side route and handshake boundary.

## Smoke test

### Protocol v1

1. Deploy the Worker.
2. Configure and redeploy the frontend.
3. Open the site in two separate browsers or one normal and one private window.
4. Confirm both clients connect to the same room.
5. Drive in one window and confirm the other window displays the remote SU7 smoothly.
6. Refresh one window and confirm its old remote vehicle disappears before the new session joins.
7. Temporarily remove `VITE_MULTIPLAYER_ENABLED` and confirm local single-player driving still works.

### Protocol v2 routing

1. Open a WebSocket to `/ws?room=smoke&protocol=2`.
2. Confirm the first server message is a binary protocol-v2 `HELLO_REQUIRED` frame.
3. Send a valid binary HELLO and confirm the socket remains open.
4. Confirm `/ws?room=smoke&protocol=3` returns HTTP 400 with supported versions `[1, 2]`.

## Current limits

### Protocol v1

- State upload frequency: 12 Hz.
- Per-client server limit: 30 messages per rolling second.
- Maximum accepted client frame: 4096 bytes.
- Maximum remote snapshot history: 20 states.
- Remote interpolation delay: 100 ms.
- No player-to-player Rapier collision in the MVP.

### Protocol v2

- Binary handshake only in Task 10.
- No session allocation or resume token yet.
- No authoritative 60 Hz loop or state broadcast yet.
- No browser protocol-v2 transport enabled yet.

## Protocol compatibility

Protocol v1 remains the existing MessagePack state-relay contract. Protocol v2 uses the shared fixed-layout binary codec and exact version tuple:

```text
protocolVersion = 2
vehiclePhysicsVersion = 1
mapCollisionVersion = 1
```

The two protocols use separate Durable Object namespaces so protocol-v2 work cannot silently alter existing v1 rooms.
