# CH Folio Multiplayer Worker

Cloudflare Worker and Durable Object backend for the room-based multiplayer MVP.

## Architecture

- `GET /health` returns service status.
- WebSocket clients connect to `/ws?room=<room-name>`.
- The Worker maps the normalized room name to `GAME_ROOM.getByName(room)`.
- Each `GameRoom` Durable Object accepts hibernatable WebSockets.
- Player identity, latest state, sequence number and rate-limit state are stored in the WebSocket serialized attachment.
- Vehicle state is kept only for the lifetime of the connection; no gameplay state is written to SQLite.

The Durable Object namespace is declared through the Wrangler `exports` field with SQLite storage. Do not add a legacy `migrations` section to the same configuration.

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

The WebSocket endpoint is normally:

```text
ws://localhost:8787/ws?room=public
```

Run protocol tests and type checking:

```bash
npm test
npm run check
```

`npm run check` runs `wrangler types` before TypeScript so the `Env` binding type is generated from `wrangler.jsonc` rather than maintained by hand.

## Deploy

```bash
npm run deploy
```

After deployment, copy the generated Worker hostname into the frontend environment:

```env
VITE_MULTIPLAYER_ENABLED=1
VITE_SERVER_URL=wss://ch-folio-multiplayer.<account-subdomain>.workers.dev/ws
VITE_MULTIPLAYER_ROOM=public
```

Rebuild and redeploy the Vite frontend after changing any `VITE_*` variable.

## Smoke test

1. Deploy the Worker.
2. Configure and redeploy the frontend.
3. Open the site in two separate browsers or one normal and one private window.
4. Confirm both clients connect to the same room.
5. Drive in one window and confirm the other window displays the remote SU7 smoothly.
6. Refresh one window and confirm its old remote vehicle disappears before the new session joins.
7. Temporarily remove `VITE_MULTIPLAYER_ENABLED` and confirm local single-player driving still works.

## Current limits

- State upload frequency: 12 Hz.
- Per-client server limit: 30 messages per rolling second.
- Maximum accepted client frame: 4096 bytes.
- Maximum remote snapshot history: 20 states.
- Remote interpolation delay: 100 ms.
- No player-to-player Rapier collision in the MVP.
- No authentication, chat, persistence or matchmaking yet.

## Protocol compatibility

The browser and Worker both use protocol version `1` and MessagePack maps. Keep the compact field names and message semantics stable so the Worker can later be replaced by the planned Go room server without changing the renderer.
