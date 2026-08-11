import assert from 'node:assert/strict'
import test from 'node:test'

import { Metrics } from '../src/Metrics.js'

test('metrics retain bounded future queue diagnostics and late-input rate', () =>
{
    const metrics = new Metrics()
    metrics.recordInputQueueDiagnostics({
        futureInputCount: 4,
        futureLeadMaxTicks: 12,
        staleInputCount: 0,
        lateInputCount: 1,
    })
    metrics.completeTick(1)
    metrics.recordInputQueueDiagnostics({
        futureInputCount: 2,
        futureLeadMaxTicks: 8,
        staleInputCount: 0,
        lateInputCount: 2,
    })
    metrics.completeTick(2)

    const summary = metrics.readBenchmarkSummary()
    assert.equal(summary.gauges.futureInputCount, 2)
    assert.equal(summary.gauges.futureInputCountMax, 4)
    assert.equal(summary.gauges.futureLeadMaxTicks, 12)
    assert.equal(summary.gauges.staleInputMax, 0)
    assert.equal(summary.gauges.lateInputCount, 2)
    assert.equal(summary.gauges.lateInputRate, 1)
    assert.equal(summary.gauges.persistentFutureQueueGrowth, false)
})

test('metrics identify persistent future queue growth after one simulated second', () =>
{
    const metrics = new Metrics()
    for(let tick = 1; tick <= 61; tick++)
    {
        metrics.recordInputQueueDiagnostics({
            futureInputCount: tick,
            futureLeadMaxTicks: 18,
            staleInputCount: 0,
            lateInputCount: 0,
        })
        metrics.completeTick(tick)
    }

    assert.equal(
        metrics.readBenchmarkSummary().gauges.persistentFutureQueueGrowth,
        true,
    )
})