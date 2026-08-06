# Authoritative Multiplayer Benchmark Decision

## Decision

**Migrate to Node.js.**

The protocol-v2 Durable Object implementation is not approved for production cutover. Protocol v1 remains the active production multiplayer path, and `VITE_MULTIPLAYER_PROTOCOL=2` must not be enabled in production.

The decision follows the approved hard-stop rule: one local benchmark gate failed, so non-production Durable Object deployment, two-browser smoke testing, the deployed eight-client ten-minute run, and the Cloudflare isolate-memory observation were intentionally not started.

## Evidence identity

| Field | Value |
| --- | --- |
| Evidence date | 2026-08-06 |
| Benchmark implementation commit | `7295f2750ccd3fa51206ce61d3c009f029a86565` |
| Evidence workflow head | `77fbfc0d3c51e5a4fd2762aad72c853b303c1fbe` |
| Evidence workflow | Authoritative Benchmark Evidence #3 |
| Artifact name | `task-18-authoritative-benchmark-evidence` |
| Artifact SHA-256 | `47c80e8c613aea458fbb948805dcb0df75d987cb3cb6b44ad101d4d095ca933f` |
| Node.js | `v24.19.0` |
| Rapier deterministic | `0.17.3` |
| Compatibility tuple | protocol `2`, vehicle physics `1`, map collision `1` |

The evidence workflow had `contents: read`, did not deploy a Worker, did not print Cloudflare account details, and was removed after the artifact was downloaded and verified.

## Local benchmark configuration

The local candidate ran the committed `eight-car-pileup` fixture with:

- eight authoritative vehicles
- 36,000 fixed simulation ticks
- 60 Hz logical tick rate
- 600 logical seconds
- one measured primary world
- one unmeasured deterministic shadow world
- 20 Hz canonical checksum comparison
- 1 Hz Rapier snapshot SHA-256 comparison

The shadow world verifies determinism but is excluded from the measured `totalTick` duration. The completed run took 31,983.811 ms of wall time.

## Hard-gate result

| Gate | Limit | Observed | Result |
| --- | ---: | ---: | --- |
| `totalTick.p95Ms` | 8.000 ms | 0.756914 ms | Pass |
| `totalTick.p99Ms` | 12.000 ms | 2.418247 ms | Pass |
| `totalTick.maxMs` | 16.670 ms | 74.823649 ms | **Fail** |
| `maxQueueDepth` | 3 | 0 | Pass |
| persistent divergence | 0 | 0 | Pass |
| disconnects | 0 | 0 | Pass |

The benchmark process exited with code `1` because `totalTick.maxMs` exceeded its hard limit. The evidence job itself remained successful so the failing JSON report could still be uploaded and reviewed.

## Timing details

| Phase | Samples | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| total tick | 36,000 | 0.334159 ms | 0.756914 ms | 2.418247 ms | 74.823649 ms |
| Rapier step | 36,000 | 0.186870 ms | 0.292741 ms | 1.218157 ms | 44.455934 ms |
| controller/update residual | 36,000 | 0.099339 ms | 0.176994 ms | 0.310739 ms | 47.212032 ms |
| checksum | 12,000 | 0.104412 ms | 0.198097 ms | 0.800101 ms | 12.692104 ms |
| state encode | 12,000 | 0.024735 ms | 0.051282 ms | 0.099692 ms | 8.682625 ms |
| state decode | 12,000 | 0.060460 ms | 0.117202 ms | 0.239209 ms | 74.334683 ms |
| snapshot copy | 600 | 0.206363 ms | 0.326225 ms | 1.530994 ms | 4.286043 ms |
| asynchronous hash digest | 600 | 0.903091 ms | 3.446604 ms | 6.594271 ms | 19.923035 ms |

The report does not establish that one named phase caused the maximum total-tick outlier because phase samples are summarized independently rather than correlated by tick. The hard maximum is therefore retained as observed instead of being dismissed as noise.

## Determinism and queue evidence

- checksum mismatches: `0`
- snapshot hash mismatches: `0`
- persistent divergence: `0`
- queue depth: `0`
- maximum queue depth: `0`
- disconnects: `0`

The local Node process reached a peak RSS of 142,229,504 bytes (135.641 MiB). This is informational only and is not treated as the Durable Object 96 MiB gate, because Node process RSS is not equivalent to Cloudflare V8 isolate memory.

## Cloudflare deployment status

The evidence runner confirmed that Wrangler was authenticated without exposing account identity. No deployment was attempted because the local hard gate had already failed.

Consequently, these approved hosted checks are recorded as **not executed by design**:

- isolated non-production Durable Object deployment
- two-real-browser smoke test
- eight-client, ten-minute hosted load test
- hosted disconnect/restart/backlog verification
- Cloudflare isolate peak-memory observation
- Durable Object regional observation

Unknown hosted values are not converted into passes. The Worker benchmark summary endpoint and eight-client load tool remain available for future investigation, but they cannot override the failed local hard maximum without a new approved performance change and a complete re-run.

## Reproduction

Run the contract tests:

```bash
npm run test:authoritative-benchmark
```

Run the 36,000-tick local benchmark:

```bash
npm run benchmark:authoritative:local -- \
  --output=authoritative-local-benchmark.json
```

The command prints the same machine-readable JSON and exits nonzero whenever a hard gate fails.

The deployed tool is intentionally fail-closed and requires all hosted metadata:

```bash
AUTHORITATIVE_BENCHMARK_URL=wss://<isolated-worker-host>/ws \
AUTHORITATIVE_BENCHMARK_ROOM=task-18 \
AUTHORITATIVE_BENCHMARK_TOKEN=<secret-with-at-least-32-characters> \
AUTHORITATIVE_BENCHMARK_WORKER_VERSION=<deployed-version> \
AUTHORITATIVE_BENCHMARK_REGION=<observed-region> \
AUTHORITATIVE_BENCHMARK_MEMORY_BYTES=<isolate-peak-bytes> \
npm run benchmark:authoritative:worker
```

The token is sent only as a SHA-256 digest inside a fixed binary protocol-v2 frame. It is never placed in the URL or report metadata.

## Production state

- protocol v1 remains active and unchanged
- protocol v2 remains implemented and testable behind its explicit selector
- protocol v2 production cutover is blocked
- no default Worker deployment was changed
- no production secret or benchmark credential was created
- next hosting work must target a Node.js authoritative service or begin under a separately approved optimization plan
