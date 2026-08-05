# Multiplayer MVP Design

## Goal

Add an optional multiplayer layer to the existing Three.js/Rapier driving experience so players in the same room can see each other's SU7 vehicles moving smoothly. Keep local vehicle physics client-side and avoid player-to-player collision in the first release.

## Scope

### Included

- One public room by default, configurable through environment variables.
- Cloudflare Worker routing each room to one Durable Object.
- Hibernatable WebSocket connections.
- Versioned MessagePack protocol.
- Server-assigned player IDs.
- Local state upload at 12 Hz.
- Remote vehicle spawn, interpolation, steering, wheel rotation and brake-light state.
- Join, leave, reconnect and initial room snapshot handling.
- Health endpoint and deployment documentation.
- Pure protocol/interpolation tests plus source-contract tests.

### Deferred

- Player-to-player Rapier collisions.
- Server-authoritative physics and anti-cheat.
- Login, persistent identity and database-backed profiles.
- Matchmaking, private-room UI, chat, voice and leaderboards.
- Cross-room migration without reconnecting.

## Architecture

```text
Browser
  ├── Local Rapier vehicle (authoritative for local movement)
  ├── Multiplayer coordinator
  └── Remote vehicle renderers + snapshot buffers
          │
          │ WebSocket + MessagePack
          ▼
Cloudflare Worker
          │ room name -> Durable Object name
          ▼
GameRoom Durable Object
  ├── Hibernatable WebSockets
  ├── Per-socket serialized attachment
  ├── Server-side message validation/rate limiting
  └── Room-local broadcast
```

Each room maps deterministically to one Durable Object. The object stores no durable gameplay history: the current player state is serialized into each socket attachment so the room can reconstruct a snapshot after hibernation. Disconnecting removes the ephemeral player.

## Protocol

Every message is a MessagePack map with compact keys:

- `v`: protocol version, currently `1`.
- `t`: message type.
- `seq`: monotonically increasing client sequence for state messages.
- `ts`: server timestamp in milliseconds on accepted and server-generated messages.
- `id`: server-assigned player ID on server-to-client messages.
- `p`: position `[x, y, z]`.
- `q`: quaternion `[x, y, z, w]`.
- `st`: steering value clamped to `[-1, 1]`.
- `sp`: forward speed clamped to a safe finite range.
- `f`: bit flags.

Message types:

- `welcome`: server assignment plus initial players.
- `joined`: a player entered the room.
- `state`: sanitized vehicle state.
- `left`: a player disconnected.
- `ping` / `pong`: liveness measurement.
- `error`: recoverable protocol error.

Flag bits:

- `1`: braking.
- `2`: boosting.
- `4`: honking.
- `8`: left steering input.
- `16`: right steering input.

The Durable Object ignores any client-supplied player ID and replaces it with the ID stored in the WebSocket attachment.

## Frontend Components

### `Server`

Remain the transport boundary. It owns connection lifecycle, binary MessagePack encoding, exponential reconnect scheduling, room query parameters and transport events. It must not contain vehicle behavior.

### `Multiplayer`

Own local state publication and route incoming protocol messages. It waits until the asynchronous game initialization has produced the physical vehicle and local visual chassis, resolves that chassis as the remote clone template, then publishes at 12 Hz.

### `RemotePlayers`

Maintain the `playerId -> RemoteVehicle` map. Create on snapshots/state, remove on `left`, and clear all players when disconnected.

### `SnapshotBuffer`

Store a bounded ordered history per player. Render approximately 100 ms behind the newest data, interpolate position/scalars linearly and quaternion with normalized shortest-path interpolation. Ignore stale sequence numbers.

### `RemoteVehicle`

Clone the loaded local visual chassis after `VisualVehicle` has completed its setup. It renders only and never creates Rapier bodies. It discovers the four SU7 wheel nodes, applies chassis transform, front-wheel steering, wheel roll and brake-light visibility.

## Cloudflare Components

### Worker entry

- `GET /health` returns service health.
- WebSocket upgrade requests read `room`, normalize it, call `GAME_ROOM.getByName(room)` and forward the request.
- Reject non-upgrade requests to the WebSocket route.

### `GameRoom`

- Accept WebSockets with `ctx.acceptWebSocket()`.
- Generate IDs with `crypto.randomUUID()`.
- Store `playerId`, last accepted sequence, latest state and rate-limit window in `serializeAttachment()`.
- Rebuild the initial snapshot from `ctx.getWebSockets()` and attachments.
- Validate message size, version, type, finite numbers, quaternion and sequence ordering.
- Allow at most 30 client messages per rolling second.
- Broadcast server-generated `joined`, `state` and `left` messages.

## Configuration

Frontend:

```env
VITE_SERVER_URL=wss://ch-folio-multiplayer.<account>.workers.dev/ws
VITE_MULTIPLAYER_ROOM=public
VITE_MULTIPLAYER_ENABLED=1
```

Worker configuration uses a SQLite-backed Durable Object class and the current declarative `exports` lifecycle syntax.

## Failure Handling

- Multiplayer remains disabled when `VITE_MULTIPLAYER_ENABLED` or `VITE_SERVER_URL` is absent.
- A failed socket must not affect local driving.
- Reconnect delay increases up to 15 seconds and resets after a successful connection.
- Remote vehicles are removed immediately on transport disconnect to avoid stale cars.
- Invalid client messages receive an error; oversized or rate-limited clients are closed.
- A remote player with only one snapshot renders at that snapshot; stale snapshots do not rewind the car.

## Testing

- Protocol accepts valid state and rejects invalid/non-finite fields.
- Snapshot buffer ignores stale sequence numbers and interpolates position/quaternion correctly.
- Frontend integration source constructs multiplayer, keeps it optional and resolves the loaded visual chassis as the remote template.
- Worker codec, state sanitizer and rate limiter tests run with Vitest-compatible pure functions.
- Existing JavaScript tests and production build remain part of CI.

## Acceptance Criteria

- Opening the deployed site in two browsers with the same room shows two independent SU7 vehicles.
- Each browser keeps its own local Rapier movement and sees the other car smoothly at normal latency.
- Refreshing or disconnecting removes the old remote car and reconnects without breaking local driving.
- No remote Rapier collider is created, so player vehicles do not physically collide.
- The worker can hibernate without losing connected socket identity or latest state attachments.
- Frontend and Worker use protocol version `1` and interoperable MessagePack payloads.
