import assert from 'node:assert/strict'
import test from 'node:test'

import {
    evaluateBenchmarkGates,
    runLocalBenchmark,
    summarizeSamples,
} from './benchmark-authoritative-room.mjs'
import {
    buildBenchmarkWebSocketUrl,
    evaluateLoadTestGates,
    parseLoadTestOptions,
} from './loadtest-authoritative-worker.mjs'

test('benchmark summaries use nearest-rank p50 p95 p99 and max', () =>
{
    assert.deepEqual(summarizeSamples([ 5, 1, 4, 2, 3 ]), {
        count: 5,
        totalMs: 15,
        meanMs: 3,
        p50Ms: 3,
        p95Ms: 5,
        p99Ms: 5,
        maxMs: 5,
    })
})

test('local gates enforce exact tick, queue, and divergence limits', () =>
{
    const passing = evaluateBenchmarkGates({
        phases: { totalTick: { p95Ms: 8, p99Ms: 12, maxMs: 16.67 } },
        gauges: { maxQueueDepth: 3 },
        divergence: { persistent: 0 },
    })
    assert.equal(passing.pass, true)
    assert.equal(passing.failures.length, 0)

    const failing = evaluateBenchmarkGates({
        phases: { totalTick: { p95Ms: 8.01, p99Ms: 12.01, maxMs: 16.68 } },
        gauges: { maxQueueDepth: 4 },
        divergence: { persistent: 1 },
    })
    assert.equal(failing.pass, false)
    assert.deepEqual(failing.failures.map(({ gate }) => gate), [
        'totalTick.p95Ms',
        'totalTick.p99Ms',
        'totalTick.maxMs',
        'gauges.maxQueueDepth',
        'divergence.persistent',
    ])
})

test('small local run emits deterministic machine-readable benchmark metadata', async () =>
{
    const report = await runLocalBenchmark({ ticks: 120 })

    assert.equal(report.schemaVersion, 1)
    assert.equal(report.mode, 'local-node')
    assert.equal(report.metadata.fixture, 'eight-car-pileup')
    assert.equal(report.metadata.tickRateHz, 60)
    assert.equal(report.metadata.ticks, 120)
    assert.equal(report.metadata.vehicles, 8)
    assert.equal(report.divergence.persistent, 0)
    assert.equal(report.gauges.maxQueueDepth, 0)
    assert.equal(report.disconnects, 0)
    assert.equal(report.phases.totalTick.count, 120)
    assert.equal('diagnostics' in report, false)
    assert.equal(typeof JSON.parse(JSON.stringify(report)).gates.pass, 'boolean')
})

test('diagnostic local run reports wall time, CPU time, and context-switch deltas without changing gates', async () =>
{
    const report = await runLocalBenchmark({
        ticks: 120,
        diagnostics: true,
        slowTickThresholdMs: 0,
    })

    assert.equal(report.diagnostics.slowTickThresholdMs, 0)
    assert.equal(report.diagnostics.slowTicks.length, 120)
    const first = report.diagnostics.slowTicks[0]
    assert.equal(first.tick, 1)
    assert.equal(first.fixtureTick, 1)
    assert.equal(Number.isFinite(first.startTimeMs), true)
    assert.equal(Number.isFinite(first.endTimeMs), true)
    assert.equal(Number.isFinite(first.totalMs), true)
    assert.equal(Number.isFinite(first.cpuUserMs), true)
    assert.equal(Number.isFinite(first.cpuSystemMs), true)
    assert.equal(Number.isFinite(first.cpuTotalMs), true)
    assert.equal(Number.isSafeInteger(first.voluntaryContextSwitchesDelta), true)
    assert.equal(Number.isSafeInteger(first.involuntaryContextSwitchesDelta), true)
    assert.ok(first.endTimeMs >= first.startTimeMs)
    assert.ok(first.totalMs >= 0)
    assert.ok(first.cpuUserMs >= 0)
    assert.ok(first.cpuSystemMs >= 0)
    assert.equal(first.cpuTotalMs, first.cpuUserMs + first.cpuSystemMs)
    assert.ok(first.voluntaryContextSwitchesDelta >= 0)
    assert.ok(first.involuntaryContextSwitchesDelta >= 0)
    assert.equal(report.gates.pass, evaluateBenchmarkGates(report).pass)
})

test('deployed load options keep credentials out of the URL and report metadata', () =>
{
    const options = parseLoadTestOptions([], {
        AUTHORITATIVE_BENCHMARK_URL: 'wss://worker.example/ws?ignored=yes',
        AUTHORITATIVE_BENCHMARK_ROOM: '  Task-18_Load  ',
        AUTHORITATIVE_BENCHMARK_TOKEN: 'secret-token-that-must-never-appear-in-a-url',
    })

    assert.equal(options.clients, 8)
    assert.equal(options.seconds, 600)
    assert.equal(options.room, 'task-18_load')
    assert.equal(options.metadata.tokenConfigured, true)
    assert.equal('token' in options.metadata, false)

    const url = buildBenchmarkWebSocketUrl(options.url, options.room)
    assert.equal(url.searchParams.get('room'), 'task-18_load')
    assert.equal(url.searchParams.get('protocol'), '2')
    assert.equal(url.searchParams.has('token'), false)
    assert.equal(url.toString().includes(options.token), false)
})

test('deployed gates reject disconnects, backlog, overload, memory, or divergence', () =>
{
    const report = {
        worker: {
            phases: { totalTick: { p95Ms: 8, p99Ms: 12, maxMs: 16.67 } },
            gauges: { maxQueueDepth: 3 },
            scheduler: { overloadCallbacks: 0 },
            observedPeakMemoryBytes: 96 * 1024 * 1024,
        },
        disconnects: 0,
        backlog: { persistent: 0 },
        divergence: { persistent: 0 },
        roomRestarts: 0,
    }
    assert.equal(evaluateLoadTestGates(report).pass, true)

    const failing = structuredClone(report)
    failing.disconnects = 1
    failing.backlog.persistent = 1
    failing.divergence.persistent = 1
    failing.roomRestarts = 1
    failing.worker.gauges.maxQueueDepth = 4
    failing.worker.scheduler.overloadCallbacks = 1
    failing.worker.observedPeakMemoryBytes += 1
    assert.equal(evaluateLoadTestGates(failing).pass, false)
})
