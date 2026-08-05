# URL Room Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plain site URL single-player and enable multiplayer only when a valid `?room=<name>` query parameter is present.

**Architecture:** Add a small pure URL-room parser, use it in the application bootstrap, and pass the resolved room explicitly into `Multiplayer.start`. Keep the existing Worker room routing unchanged.

**Tech Stack:** JavaScript ES modules, Node.js built-in test runner, Vite, Cloudflare Workers and Durable Objects.

## Global Constraints

- No `room` parameter means no multiplayer WebSocket connection.
- Valid rooms contain only `a-z`, `0-9`, `-`, and `_`, with a maximum length of 64.
- Room names are trimmed and lowercased.
- Invalid or empty room parameters fall back silently to single-player.
- `VITE_MULTIPLAYER_ROOM` must not provide an implicit default room.
- The Worker protocol and Durable Object implementation remain unchanged.

---

### Task 1: Add URL room parsing contract

**Files:**
- Create: `sources/Game/Multiplayer/roomFromUrl.js`
- Create: `scripts/test_multiplayer_room_url.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolveRoomFromSearch(search: string): string | null`

- [ ] **Step 1: Write the failing parser tests**

Create tests asserting:

```js
assert.equal(resolveRoomFromSearch(''), null)
assert.equal(resolveRoomFromSearch('?foo=1'), null)
assert.equal(resolveRoomFromSearch('?room='), null)
assert.equal(resolveRoomFromSearch('?room=%20ABC_12-%20'), 'abc_12-')
assert.equal(resolveRoomFromSearch('?room=hello/world'), null)
assert.equal(resolveRoomFromSearch(`?room=${'a'.repeat(65)}`), null)
```

- [ ] **Step 2: Register and run the test to verify RED**

Run:

```bash
npm run test:multiplayer
```

Expected: failure because `sources/Game/Multiplayer/roomFromUrl.js` does not exist.

- [ ] **Step 3: Implement the minimal parser**

```js
const ROOM_PATTERN = /^[a-z0-9_-]{1,64}$/

export const resolveRoomFromSearch = (search = '') =>
{
    const value = new URLSearchParams(search).get('room')
    if(value === null)
        return null

    const room = value.trim().toLowerCase()
    return ROOM_PATTERN.test(room) ? room : null
}
```

- [ ] **Step 4: Run the parser tests to verify GREEN**

Run:

```bash
npm run test:multiplayer
```

Expected: all multiplayer tests pass.

- [ ] **Step 5: Commit**

```bash
git add sources/Game/Multiplayer/roomFromUrl.js scripts/test_multiplayer_room_url.mjs package.json
git commit -m "test: define URL room parsing"
```

### Task 2: Gate multiplayer startup by URL room

**Files:**
- Modify: `sources/index.js`
- Modify: `sources/Game/Multiplayer/Multiplayer.js`
- Modify: `scripts/test_multiplayer.mjs`

**Interfaces:**
- Consumes: `resolveRoomFromSearch(search)` from Task 1.
- Changes: `Multiplayer.start({ room }: { room: string }): boolean`.

- [ ] **Step 1: Write failing bootstrap and coordinator assertions**

Add source-contract tests asserting that `sources/index.js`:

```js
assert.match(source, /resolveRoomFromSearch\(window\.location\.search\)/)
assert.match(source, /multiplayer\.start\(\{\s*room\s*\}\)/)
```

Add assertions that `Multiplayer.js`:

```js
assert.match(source, /start\(\{\s*room\s*\}\s*=\s*\{\}\)/)
assert.doesNotMatch(source, /VITE_MULTIPLAYER_ROOM/)
assert.match(source, /this\.server\.start\(\{[\s\S]*room/)
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm run test:multiplayer
```

Expected: failure because the bootstrap still starts multiplayer without a URL-derived room and `Multiplayer.start` still reads the environment default.

- [ ] **Step 3: Implement URL-gated startup**

In `sources/index.js`:

```js
import { resolveRoomFromSearch } from './Game/Multiplayer/roomFromUrl.js'

const multiplayerRoom = resolveRoomFromSearch(window.location.search)

if(multiplayerEnabled && import.meta.env.VITE_SERVER_URL && multiplayerRoom)
    multiplayer.start({ room: multiplayerRoom })
```

In `Multiplayer.js`:

```js
start({ room } = {})
{
    if(this.started || !room)
        return false

    this.started = true
    this.bindServerEvents()
    const started = this.server.start({
        url: import.meta.env.VITE_SERVER_URL,
        room,
    })

    if(!started)
        this.started = false

    return started
}
```

- [ ] **Step 4: Run multiplayer tests to verify GREEN**

Run:

```bash
npm run test:multiplayer
```

Expected: all URL-room and multiplayer source-contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add sources/index.js sources/Game/Multiplayer/Multiplayer.js scripts/test_multiplayer.mjs
git commit -m "feat: enter multiplayer rooms from URL"
```

### Task 3: Verify the complete application

**Files:**
- No production file changes expected.

**Interfaces:**
- Verifies the complete frontend and Worker build contracts.

- [ ] **Step 1: Run all root tests**

```bash
npm test
```

Expected: JavaScript and Python tests pass.

- [ ] **Step 2: Run the production frontend build**

```bash
npm run build
```

Expected: Vite production build succeeds.

- [ ] **Step 3: Run Worker tests and checks**

```bash
npm test --prefix multiplayer-worker
npm run check --prefix multiplayer-worker
```

Expected: Worker protocol tests, Wrangler type generation and TypeScript checks pass.

- [ ] **Step 4: Open and merge a pull request after CI passes**

Use a squash merge with a title describing URL-based room entry. The merged `main` commit should trigger the existing Pages deployment; no Worker redeployment is needed.
