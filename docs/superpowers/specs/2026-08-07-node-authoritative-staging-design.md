# Node.js Authoritative Staging and Benchmark Design

## Goal

Validate the Node.js protocol-v2 authoritative server on the existing `hk-server` self-hosted Linux host before any production multiplayer cutover. The staging service must use the exact protocol, deterministic physics, map, room limits, tick rate, input delay, and resume behavior already implemented in PR #13 while keeping production protocol v1 and all production browser environment variables unchanged.

## Decision

Use `hk-server` as a non-production validation host only. Run the Node authoritative server as a supervised local service bound to loopback and publish it through a dedicated Cloudflare Tunnel hostname. The staging hostname is operational configuration selected when the tunnel route is created; it is not committed into browser production configuration.

The Node service listens on `127.0.0.1:8080`. `cloudflared` runs on the same host and maps the dedicated non-production public hostname to `http://127.0.0.1:8080`. TLS terminates at Cloudflare. The origin is reachable only over loopback, so no inbound game-server port is opened on `hk-server`.

## Alternatives considered

### Cloudflare Tunnel to loopback — selected

Advantages:

- no public origin port or origin IP exposure is required;
- the existing Cloudflare zone can provide HTTPS/WSS at the public edge;
- the public hostname can be isolated from the production Pages site;
- the tunnel can be removed independently without changing protocol v1;
- the same service supports `GET /healthz` and WebSocket upgrades at `/ws`.

### Quick Tunnel — rejected

A Quick Tunnel would reduce setup work, but its random hostname and testing-oriented limits make it unsuitable for a repeatable ten-minute benchmark and geographically separated browser acceptance.

### Public Node port behind a reverse proxy — rejected

Opening a public port and adding a separate reverse proxy would create unnecessary ingress, TLS, firewall, and certificate-management work for a staging-only validation host.

## Scope

This increment provides:

- a repeatable 36,000-tick local benchmark gate on the exact staged commit;
- Node-side benchmark metrics compatible with the existing shared benchmark protocol;
- a supervised Node staging process on `hk-server`;
- a dedicated Cloudflare Tunnel route to the loopback service;
- a public non-production `wss://` endpoint for protocol-v2 testing;
- an eight-client, ten-minute hosted load test;
- two-browser smoke acceptance and later geographically separated acceptance;
- evidence documentation that records the exact commit, Node version, Rapier version, compatibility tuple, benchmark results, and staging endpoint state.

This increment does not change `VITE_MULTIPLAYER_ENABLED`, `VITE_MULTIPLAYER_PROTOCOL`, `VITE_SERVER_URL`, protocol v1, the production Pages deployment, or the production multiplayer endpoint.

## Staging process architecture

### Node service

The service runs from the repository checkout for one exact Git commit using Node.js 24 and the committed `authoritative-node/package-lock.json`. Installation uses:

```bash
npm ci --prefix authoritative-node --ignore-scripts
```

The service runs with:

```text
HOST=127.0.0.1
PORT=8080
```

A systemd service supervises the process. Restart-on-failure is allowed for staging, but any restart during a benchmark run is a hard benchmark failure. Secrets are provided through a host-only environment file and are never committed.

### Cloudflare Tunnel

`cloudflared` runs on `hk-server` and publishes exactly one staging hostname to:

```text
http://127.0.0.1:8080
```

The tunnel configuration ends with a catch-all `http_status:404` rule. The public hostname is used only for validation and is never written into production Pages environment variables during this increment.

The staging endpoint therefore exposes:

- `https://<staging-host>/healthz`
- `wss://<staging-host>/ws?room=<room>&protocol=2`

The literal staging hostname is intentionally deployment configuration rather than a source-code constant.

## Benchmark metrics

### Shared wire contract

Reuse the existing `BENCHMARK_SUMMARY_REQUEST` and `BENCHMARK_SUMMARY` binary frames from `@ch-folio/authoritative-physics`. The Node server accepts a summary request only from an active protocol-v2 session and only when the request contains the SHA-256 digest of the configured benchmark token.

The benchmark token:

- must contain at least 32 characters;
- is supplied only through the staging process environment;
- is never placed in a URL;
- is never included in report metadata;
- is compared in constant time after digesting.

### Node metrics

Add Node-local metrics rather than moving the Worker metrics implementation into the shared package. This keeps the hosting implementations isolated while reusing the same wire schema and gate semantics.

The Node room records:

- per-tick total duration;
- scheduler callback count;
- catch-up ticks;
- overload callbacks;
- maximum due ticks;
- current and maximum queued input depth;
- current and maximum slots;
- disconnect count;
- process restart identity for the staged instance;
- Node process RSS as operational evidence.

The metrics window retains at most the latest 36,000 completed ticks.

Node process RSS is recorded but the Durable Object 96 MiB isolate limit is not reused as a Node hard gate because process RSS and V8 isolate memory are not equivalent measurements.

## Validation sequence

### Gate 1: CI

The exact staging candidate commit must pass the existing Verify workflow, including root tests, deterministic physics tests, Node tests, Vite build, Worker tests/checks, and Wrangler dry-run.

Any failure stops staging deployment.

### Gate 2: 36,000-tick local benchmark

Run the existing committed `eight-car-pileup` 36,000-tick benchmark on `hk-server` against the exact candidate commit.

Hard limits remain unchanged:

| Metric | Limit |
| --- | ---: |
| `totalTick.p95Ms` | `<= 8.000 ms` |
| `totalTick.p99Ms` | `<= 12.000 ms` |
| `totalTick.maxMs` | `<= 16.670 ms` |
| maximum queue depth | `<= 3` |
| persistent divergence | `0` |
| disconnects | `0` |

The previous Durable Object evidence failed the maximum-tick gate. That result is not waived. The Node staging candidate must produce a new complete 36,000-tick report and pass every hard limit before hosted validation starts.

### Gate 3: staging deployment smoke test

After Gate 2 passes:

1. install the exact candidate with `npm ci`;
2. start the supervised loopback Node service;
3. verify `GET /healthz` locally;
4. start or reload the Cloudflare Tunnel route;
5. verify the public health endpoint;
6. connect two real browsers to one staging room;
7. verify handshake, spawn, bidirectional collision, flip/impact behavior, disconnect/resume, and room isolation.

Any process restart, protocol error, divergence, or unexpected disconnect blocks the load test.

### Gate 4: eight-client, ten-minute hosted load test

Reuse the existing load-test client with a Node staging mode. The run uses exactly eight clients for exactly 600 seconds against one isolated staging room.

Hard limits:

| Metric | Limit |
| --- | ---: |
| server `totalTick.p95Ms` | `<= 8.000 ms` |
| server `totalTick.p99Ms` | `<= 12.000 ms` |
| server `totalTick.maxMs` | `<= 16.670 ms` |
| maximum input queue depth | `<= 3` |
| scheduler overload callbacks | `0` |
| unexpected disconnects | `0` |
| persistent state backlog | `0` |
| checksum/hash divergence | `0` |
| staging process restarts | `0` |

Process RSS, wall duration, state-frame counts, and send-deadline misses are recorded as evidence. They do not replace any hard gate.

### Gate 5: geographically separated acceptance

Only after Gate 4 passes, run the multiplayer acceptance from geographically separated clients against the same staging endpoint. Acceptance covers collision symmetry, knockback, rollover, safe spawn, state convergence, reconnect within the 180-tick grace period, and clean expiry after grace.

This gate produces acceptance evidence only. It still does not change production browser environment variables.

## Failure handling

- CI failure: do not deploy staging.
- 36,000-tick local benchmark failure: stop before Tunnel/public deployment.
- Local service health failure: keep Tunnel unpublished or disabled.
- Tunnel health failure: do not start browser/load acceptance.
- Any benchmark hard-gate failure: keep protocol v1 as production and record the failed evidence without reinterpretation.
- Staging process restart during a load run: fail the run.
- Benchmark token mismatch: reject the binary summary request without exposing the expected token or digest.

## Rollback

Staging rollback is independent of production:

1. disable the staging Cloudflare Tunnel route;
2. stop and disable the staging Node systemd service;
3. retain benchmark evidence and logs;
4. leave production Pages and protocol v1 untouched.

Because this increment never points production clients at the staging hostname, staging rollback requires no browser rebuild and no production multiplayer rollback.

## Evidence requirements

The final staging evidence document records:

- Git commit SHA;
- Verify workflow run;
- Node.js version;
- Rapier deterministic version;
- protocol/vehicle/map compatibility tuple;
- 36,000-tick local benchmark JSON and hard-gate table;
- staging service health result;
- Tunnel hostname category as non-production without recording secrets;
- two-browser smoke result;
- eight-client/600-second load-test JSON and hard-gate table;
- process restart count;
- process RSS observation;
- geographically separated acceptance result when executed;
- explicit statement that production protocol v1 remains active until a separate controlled cutover.

## Production cutover boundary

Task 19 remains a separate controlled production action. It may begin only after all staging gates above are green and the evidence has been reviewed. Only that later task may set production values equivalent to:

```text
VITE_MULTIPLAYER_ENABLED=1
VITE_MULTIPLAYER_PROTOCOL=2
VITE_SERVER_URL=wss://<approved-production-authoritative-host>/ws
```

The production authoritative hostname is deliberately not selected by this staging design.
