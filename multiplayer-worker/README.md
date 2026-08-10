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

The protocol-v2 flow is:

1. Accept the WebSocket through the Durable Object Hibernation API.
2. Send a fixed binary `HELLO_REQUIRED` frame.
3. Accept a binary HELLO for a new session or a binary RESUME for a disconnected session.
4. Return a binary session grant containing a random 32-byte resume token.
5. Send a binary FULL_SYNC frame.
6. Wait for binary `SYNC_READY` before scanning deterministic safe spawns.
7. Run the authoritative Rapier room at a fixed 60 Hz while at least one slot exists.
8. Accept binary input batches and broadcast a binary STATE frame every three ticks, producing a 20 Hz network cadence.
9. Return a new FULL_SYNC after a valid binary `FULL_SYNC_REQUEST`.

The browser protocol-v2 coordinator, local full-room prediction, rollback, hard sync, visual reconciliation, render-only remote vehicles, room-scoped resume credentials, and explicit v1/v2 selection are implemented. They remain behind `VITE_MULTIPLAYER_PROTOCOL=2` and are not approved for production cutover.

The room keeps at most eight stable entity slots. Resume-token digests, session state, connection generations, Rapier state, and the room scheduler remain in active Durable Object memory; gameplay state is not written to SQLite.

A disconnected slot remains reserved for exactly 180 server ticks. A valid RESUME rotates the token and increments the connection generation. When the final slot expires or is released, the scheduler stops and the Rapier world, room simulation, pending hashes, and transient metrics are destroyed.

Both Durable Object classes are declared through Wrangler `exports` with SQLite storage. Do not add a legacy `migrations` section to this configuration.

## Authoritative timing and diagnostics

The protocol-v2 room uses integer logical ticks and never passes elapsed wall-clock time into physics:

- simulation rate: 60 Hz
- state broadcast rate: 20 Hz
- maximum catch-up work per scheduler callback: three ticks
- world snapshot/hash cadence: every 60 ticks
- rolling log-summary cadence: every 600 ticks
- bounded benchmark window: latest 36,000 completed ticks

At a hash boundary the Worker copies the Rapier snapshot synchronously, then calculates SHA-256 asynchronously. The completed hash is attached to the first later STATE frame, so hashing never changes the physics step size.

Metrics include scheduler overload, catch-up work, maximum per-slot queued-input depth, occupied slots, decode/encode/broadcast time, snapshot/checksum time, controller-update time, total Rapier-step time, completed total-tick time, and benchmark-window disconnects. The frozen Rapier `0.17.3` build does not expose the newer internal broad-phase, narrow-phase, CCD, and solver timing methods; those methods are probed defensively and reported only when available.

### Authenticated benchmark summary

Protocol v2 reserves two fixed binary frame types for benchmark evidence:

- benchmark summary request: a 32-byte SHA-256 token digest
- benchmark summary response: bounded machine-readable JSON, at most 64 KiB

The endpoint is disabled unless `AUTHORITATIVE_BENCHMARK_TOKEN` is present as a Worker secret with at least 32 characters. Invalid or missing authentication receives a controlled protocol error. The token itself is never accepted in a URL, echoed in JSON, or logged by the room.

Set the secret only on an isolated benchmark Worker:

```bash
cd multiplayer-worker
npx wrangler secret put AUTHORITATIVE_BENCHMARK_TOKEN \
  --name <isolated-benchmark-worker-name>
```

Do not add the benchmark token to `wrangler.jsonc`, frontend environment variables, query parameters, or committed files.

## Requirements

- Node.js 24 or newer.
- A Cloudflare account with Workers enabled.
- Wrangler authenticated with the target account for deployment work.

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

## Benchmark commands

From the repository root, run benchmark contracts:

```bash
npm run test:authoritative-benchmark
```

Run the local eight-car, 36,000-tick benchmark:

```bash
npm run benchmark:authoritative:local -- \
  --output=authoritative-local-benchmark.json
```

The command emits JSON and exits nonzero when any hard gate fails.

The hosted tool requires exactly eight clients and defaults to ten minutes:

```bash
AUTHORITATIVE_BENCHMARK_URL=wss://<isolated-worker-host>/ws \
AUTHORITATIVE_BENCHMARK_ROOM=task-18 \
AUTHORITATIVE_BENCHMARK_TOKEN=<secret-with-at-least-32-characters> \
AUTHORITATIVE_BENCHMARK_WORKER_VERSION=<deployed-version> \
AUTHORITATIVE_BENCHMARK_REGION=<observed-region> \
AUTHORITATIVE_BENCHMARK_MEMORY_BYTES=<isolate-peak-bytes> \
npm run benchmark:authoritative:worker
```

The hosted report fails closed when deployment metadata or isolate-memory evidence is missing. Cloudflare memory evidence must be recorded as an isolate-level observation; Node process RSS is not interchangeable with Durable Object isolate memory.

Hard gates are:

- total tick p95 no more than 8 ms
- total tick p99 no more than 12 ms
- total tick maximum no more than 16.67 ms
- maximum queued-input depth no more than three ticks
- no persistent checksum or snapshot-hash divergence
- hosted run only: no disconnect, room restart, persistent backlog, scheduler overload, or isolate-memory value above 96 MiB

## Benchmark decision

The completed 36,000-tick local run failed the hard maximum-tick gate:

- p95: 0.756914 ms
- p99: 2.418247 ms
- maximum: 74.823649 ms, limit 16.67 ms
- maximum queue depth: 0
- persistent divergence: 0
- disconnects: 0

Per the approved hard-stop rule, the isolated Durable Object deployment and hosted eight-client run were not started. The recorded hosting decision is:

**Migrate to Node.js.**

See [`docs/multiplayer-authoritative-benchmark.md`](../docs/multiplayer-authoritative-benchmark.md) for the evidence identity, phase timings, gate table, and deployment status.

Protocol v1 remains active. Do not enable protocol v2 in the production frontend.

## Deploy

The default deploy command targets the configured Worker:

```bash
npm run deploy
```

Production frontend configuration remains on protocol v1:

```env
VITE_MULTIPLAYER_ENABLED=1
VITE_SERVER_URL=wss://ch-folio-multiplayer.<account-subdomain>.workers.dev/ws
VITE_MULTIPLAYER_PROTOCOL=1
```

A valid room still comes from the normalized page query. Rebuild and redeploy the Vite frontend after changing any `VITE_*` variable.

Do not switch the production frontend to `VITE_MULTIPLAYER_PROTOCOL=2`. Task 18 rejected Durable Object production hosting because the local maximum-tick gate failed.

## Smoke test

### Protocol v1

1. Deploy the Worker.
2. Configure and redeploy the frontend.
3. Open the site in two separate browsers or one normal and one private window.
4. Confirm both clients connect to the same room.
5. Drive in one window and confirm the other window displays the remote SU7 smoothly.
6. Refresh one window and confirm its old remote vehicle disappears before the new session joins.
7. Temporarily remove `VITE_MULTIPLAYER_ENABLED` and confirm local single-player driving still works.

### Protocol v2 development only

1. Use an isolated non-production Worker.
2. Open a WebSocket to `/ws?room=smoke&protocol=2`.
3. Confirm the first server message is a binary `HELLO_REQUIRED` frame.
4. Send a compatible binary HELLO.
5. Confirm the server returns a binary session grant followed by FULL_SYNC.
6. Send `SYNC_READY` and confirm the exact authoritative spawn appears.
7. Confirm STATE frames arrive at a 20 Hz logical cadence with monotonically increasing server ticks.
8. Disconnect, reconnect within 180 server ticks using RESUME, and confirm the token rotates.
9. Confirm the previous token is rejected after a successful resume.
10. Confirm `/ws?room=smoke&protocol=3` returns HTTP 400 with supported versions `[1, 2]`.

This development smoke procedure does not constitute production acceptance. The approved Task 18 hosted smoke was stopped before deployment after the local hard gate failed.

## Current limits

### Protocol v1

- State upload frequency: 12 Hz.
- Per-client server limit: 30 messages per rolling second.
- Maximum accepted client frame: 4096 bytes.
- Maximum remote snapshot history: 20 states.
- Remote interpolation delay: 100 ms.
- No player-to-player Rapier collision in the v1 path.

### Protocol v2

- Maximum eight occupied or grace-period slots per room.
- Fixed 60 Hz authoritative simulation and 20 Hz state delivery.
- Three-tick input-buffer contract.
- 180-tick resume grace with token rotation and connection-generation takeover.
- Active rooms intentionally keep a scheduler callback pending; empty rooms stop the timer and become eligible for hibernation.
- Browser prediction and reconciliation are implemented, but production cutover is blocked by the benchmark decision.
- The benchmark summary endpoint is disabled unless an isolated Worker secret is configured.

## Protocol compatibility

Protocol v1 remains the existing MessagePack state-relay contract. Protocol v2 uses the shared fixed-layout binary codec and exact version tuple:

```text
protocolVersion = 2
vehiclePhysicsVersion = 1
mapCollisionVersion = 1
```

The two protocols use separate Durable Object namespaces so protocol-v2 work cannot silently alter existing v1 rooms.
