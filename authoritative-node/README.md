# Node.js Authoritative Server

This package is the non-production Node.js host for multiplayer protocol v2. It reuses the repository's deterministic Rapier `0.17.3` world, generated collision map, binary codecs, eight-slot room simulation, three-tick input buffer, and 180-tick resume grace.

Protocol v1 remains the production multiplayer path. This package does not change `VITE_SERVER_URL`, enable `VITE_MULTIPLAYER_PROTOCOL=2`, or deploy infrastructure.

## Requirements

- Node.js 24 or newer
- repository dependencies available locally

## Install and test

```bash
npm install --prefix authoritative-node --ignore-scripts
npm test --prefix authoritative-node
```

The test suite uses real loopback WebSockets and also runs all eleven committed deterministic collision fixtures. It must match 440 checksum samples and 22 snapshot hashes exactly.

## Run locally

```bash
HOST=127.0.0.1 PORT=8080 npm start --prefix authoritative-node
```

Environment variables:

- `HOST`: listen address; defaults to `0.0.0.0` in the executable configuration.
- `PORT`: TCP port from `0` through `65535`; defaults to `8080`.

## HTTP and WebSocket routes

Health:

```text
GET /healthz
```

The bounded JSON response reports readiness, protocol/physics/map versions, Node and Rapier versions, uptime, room count, and active socket count. It does not expose room contents, player identifiers, or resume credentials.

Protocol v2 WebSocket:

```text
/ws?room=<room>&protocol=2
```

Room names are trimmed, lowercased, limited to 64 characters, and may contain only `a-z`, `0-9`, `_`, and `-`. Resume tokens are sent only inside binary protocol frames and never in the URL.

The server lifecycle is:

1. Send binary `HELLO_REQUIRED`.
2. Accept HELLO or RESUME.
3. Send a rotated session grant followed by FULL_SYNC.
4. Accept `SYNC_READY`, `INPUT_BATCH`, and `FULL_SYNC_REQUEST`.
5. Simulate at fixed 60 Hz and broadcast STATE every three ticks (20 Hz).
6. Keep disconnected vehicles for exactly 180 ticks before deterministic despawn.

The `ws` server runs in `noServer` mode behind Node's HTTP upgrade event. Per-message compression is disabled. A ping/pong heartbeat removes stale network connections without changing logical simulation ticks.

## Production status

This is an implementation and verification foundation only. TLS termination, process supervision, persistence, horizontal room placement, deployment manifests, hosted load testing, and browser endpoint cutover require separate approval and work.
