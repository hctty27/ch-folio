import assert from 'node:assert/strict'
import test from 'node:test'

import { Metrics } from '../src/Metrics.js'

test('benchmark summary uses nearest-rank percentiles and maximum', () =>
{
    const metrics = new Metrics()
    for(const [ tick, value ] of [ 5, 1, 4, 2, 3 ].entries())
    {
        metrics.recordPhase('totalTick', value)
        metrics.completeTick(tick + 1)
    }

    assert.deepEqual(metrics.readBenchmarkSummary().phases.totalTick, {
        count: 5,
        totalMs: 15,
        meanMs: 3,
        p50Ms: 3,
        p95Ms: 5,
        p99Ms: 5,
        maxMs: 5,
    })
})

test('benchmark summary tracks scheduler, queue, slots, and disconnects', () =>
{
    const metrics = new Metrics()
    metrics.recordPhase('totalTick', 4)
    metrics.recordQueueDepth(2)
    metrics.setSlots(8)
    metrics.recordSchedulerCallback(4, 3)
    metrics.recordDisconnect()
    metrics.completeTick(1)

    const summary = metrics.readBenchmarkSummary()
    assert.deepEqual(summary.scheduler, {
        callbacks: 1,
        catchUpTicks: 2,
        overloadCallbacks: 1,
        maxDueTicks: 4,
    })
    assert.deepEqual(summary.gauges, {
        queueDepth: 2,
        maxQueueDepth: 2,
        slots: 8,
        maxSlots: 8,
    })
    assert.equal(summary.disconnects, 1)
})

test('benchmark phases zero-fill before a phase first appears', () =>
{
    const metrics = new Metrics()
    metrics.recordPhase('totalTick', 2)
    metrics.completeTick(1)
    metrics.recordPhase('totalTick', 3)
    metrics.recordPhase('encode', 1)
    metrics.completeTick(2)

    const summary = metrics.readBenchmarkSummary()
    assert.equal(summary.phases.totalTick.count, 2)
    assert.deepEqual(summary.phases.encode, {
        count: 2,
        totalMs: 1,
        meanMs: 0.5,
        p50Ms: 0,
        p95Ms: 1,
        p99Ms: 1,
        maxMs: 1,
    })
})

test('benchmark ticks must increase strictly', () =>
{
    const metrics = new Metrics()
    metrics.completeTick(1)
    assert.throws(() => metrics.completeTick(1), /strictly increasing/u)
    assert.throws(() => metrics.completeTick(0), /strictly increasing/u)
})

test('benchmark retains only the latest 36000 completed ticks', () =>
{
    const metrics = new Metrics()
    for(let tick = 1; tick <= 36_001; tick++)
    {
        metrics.recordPhase('totalTick', tick === 1 ? 1000 : 1)
        metrics.completeTick(tick)
    }

    const summary = metrics.readBenchmarkSummary()
    assert.equal(summary.startTick, 2)
    assert.equal(summary.endTick, 36_001)
    assert.equal(summary.ticks, 36_000)
    assert.equal(summary.phases.totalTick.count, 36_000)
    assert.equal(summary.phases.totalTick.maxMs, 1)
})

test('metrics reject invalid durations and counters', () =>
{
    const metrics = new Metrics()
    assert.throws(() => metrics.recordPhase('', 1), /non-empty/u)
    assert.throws(() => metrics.recordPhase('tick', -1), /non-negative/u)
    assert.throws(() => metrics.recordQueueDepth(-1), /non-negative/u)
    assert.throws(() => metrics.setSlots(1.5), /safe integer/u)
    assert.throws(() => metrics.recordSchedulerCallback(1, 2), /cannot exceed/u)
})
