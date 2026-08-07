# Node.js Authoritative Server Foundation Design

## Goal

Create a standalone Node.js protocol-v2 authoritative server that reuses the existing deterministic physics package and browser wire contract, without changing protocol v1 or enabling protocol v2 in production.

## Scope

The first Node.js increment provides:

- `GET /healthz` with bounded JSON health metadata.
- WebSocket upgrade at `/ws?room=<room>&protocol=2`.
- Normalized room names using the existing 1-64 character lowercase room contract.
- One in-memory room runtime per normalized room.
- Maximum eight sessions per room.
- HELLO and RESUME handshakes with 256-bit rotating resume tokens.
- `SYNC_READY`, `INPUT_BATCH`, and `FULL_SYNC_REQUEST` handling.
- Fixed 60 Hz room simulation and 20 Hz state broadcast.
- Exact 180-tick disconnect grace and deterministic despawn.
- Graceful room/server shutdown and heartbeat-based stale-socket cleanup.
- Machine-readable room/server metrics sufficient for tests and later load work.

The first increment does not provide production deployment files, TLS termination, persistence, horizontal sharding, process clustering, browser URL cutover, or protocol changes.

## Architecture

### HTTP and WebSocket edge

Use Node's `node:http` server for health responses and the HTTP upgrade boundary. Use `ws` in `noServer` mode so the application validates path, room, and protocol before accepting the WebSocket. Per-message deflate remains disabled because protocol-v2 frames are already bounded binary structures and compression adds latency and memory variability.

### Room registry

`RoomRegistry` maps normalized room names to `NodeAuthoritativeRoom` instances. A room starts its scheduler only after its first slot is allocated and destroys its world after the final slot expires or is released. Empty rooms are removed from the registry.

### Authoritative room

`NodeAuthoritativeRoom` owns:

- one generated authoritative map,
- one deterministic `AuthoritativeWorld`,
- one shared `RoomSimulation`,
- one session registry,
- active socket attachments,
- a fixed-rate scheduler,
- state/event cursors and deferred snapshot hashes.

The room sends `HELLO_REQUIRED` immediately after connection. The first binary client frame must be HELLO or RESUME. Active sessions may send only `SYNC_READY`, `INPUT_BATCH`, or `FULL_SYNC_REQUEST`. Text, malformed, stale-generation, or unexpected frames receive controlled binary errors and a policy/protocol close.

### Session security

Resume tokens are 32 random bytes encoded as canonical unpadded base64url. Only SHA-256 digests are retained in room memory. Resume rotates the token and increments the connection generation. Old sockets cannot control the resumed entity.

### Scheduling

Use an absolute-deadline 60 Hz scheduler with integer tick deadlines and a maximum of three catch-up ticks per callback, matching the Durable Object contract. Every third completed tick emits a state frame. The scheduler stops when the room has no slots.

### Health and observability

`GET /healthz` reports process readiness, protocol/physics/map versions, uptime, room count, active socket count, and Node version. It must not expose tokens, player identifiers, room contents, or raw errors.

## Data flow

1. HTTP upgrade validates `/ws`, `protocol=2`, and normalized room.
2. Registry creates or reuses the room and attaches the socket.
3. Room sends binary `HELLO_REQUIRED`.
4. Client sends HELLO or RESUME.
5. Room allocates/resumes the exact entity slot, sends the session grant, then FULL_SYNC.
6. Client sends `SYNC_READY`; the simulation scans deterministic spawns every three ticks.
7. Client sends batched quantized inputs; the room consumes them three server ticks later.
8. Room broadcasts STATE every three ticks and includes completed 1 Hz world hashes on the first later frame.
9. Disconnect places the session in 180-tick grace; resume preserves the entity, expiry despawns it.

## Error handling

- Invalid HTTP path/query: reject upgrade with a bounded HTTP error and destroy the socket.
- Text or malformed binary frames: binary protocol error, then close.
- Ninth session: `ROOM_FULL` and close.
- Invalid/expired resume: `INVALID_RESUME` and close.
- Stale socket generation: `STALE_CONNECTION` and close.
- Internal room failure: `SESSION_FAILURE`, close affected sockets, and keep other rooms isolated.
- Shutdown: stop accepting upgrades, close sockets, stop schedulers, destroy worlds.

## Testing

Tests use Node's built-in test runner and real loopback sockets. They cover:

- health endpoint and bounded metadata,
- upgrade validation and credential-free URLs,
- HELLO/session grant/FULL_SYNC order,
- `SYNC_READY` spawn and 20 Hz state delivery,
- input routing to the assigned entity only,
- room-full behavior,
- disconnect/resume token rotation and stale-socket rejection,
- exact 180-tick expiry using an injected deterministic clock,
- room isolation and cleanup,
- graceful server shutdown,
- shared deterministic fixture compatibility.

The root Verify workflow installs and tests the Node package but does not deploy it or change production environment variables.
