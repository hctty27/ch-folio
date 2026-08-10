import assert from 'node:assert/strict'
import test from 'node:test'

import {
    decodeBenchmarkSummary,
    digestBenchmarkToken,
    encodeBenchmarkSummaryRequest,
} from '@ch-folio/authoritative-physics'
import { BenchmarkNodeAuthoritativeRoom } from '../src/BenchmarkNodeAuthoritativeRoom.js'

const BENCHMARK_TOKEN = 'benchmark-token-0123456789abcdef0123456789abcdef'

function seedBenchmarkMetrics(room)
{
    room.metrics.recordPhase('totalTick', 20)
    room.metrics.recordSchedulerCallback(5, 3)
    room.metrics.recordQueueDepth(4)
    room.metrics.setSlots(8)
    room.metrics.recordDisconnect()
    room.metrics.recordInputQueueDiagnostics({
        futureInputCount: 4,
        futureLeadMaxTicks: 9,
        staleInputCount: 0,
        lateInputCount: 3,
    })
    room.metrics.completeTick(1)
}

test('authenticated benchmark summary snapshots then resets measurement counters', async () =>
{
    const room = new BenchmarkNodeAuthoritativeRoom({
        room: 'benchmark-boundary',
        autoSchedule: false,
        benchmarkToken: BENCHMARK_TOKEN,
    })
    try
    {
        room.ensureRuntime()
        seedBenchmarkMetrics(room)

        let sentFrame = null
        room.safeSend = (_socket, frame) =>
        {
            sentFrame = frame
            return true
        }

        await room.acceptBenchmarkSummary({}, encodeBenchmarkSummaryRequest({
            tokenDigest: await digestBenchmarkToken(BENCHMARK_TOKEN),
        }))

        assert.ok(sentFrame)
        const sent = decodeBenchmarkSummary(sentFrame)
        assert.equal(sent.metrics.ticks, 1)
        assert.equal(sent.metrics.phases.totalTick.maxMs, 20)
        assert.equal(sent.metrics.scheduler.overloadCallbacks, 1)
        assert.equal(sent.metrics.disconnects, 1)
        assert.equal(sent.metrics.gauges.lateInputCount, 3)

        const after = room.metrics.readBenchmarkSummary()
        assert.equal(after.ticks, 0)
        assert.deepEqual(after.phases, {})
        assert.equal(after.scheduler.overloadCallbacks, 0)
        assert.equal(after.disconnects, 0)
        assert.equal(after.gauges.lateInputCount, 3)
        assert.equal(after.gauges.lateInputRate, 0)
    }
    finally
    {
        await room.destroy()
    }
})

test('failed benchmark summary send keeps measurement counters intact', async () =>
{
    const room = new BenchmarkNodeAuthoritativeRoom({
        room: 'benchmark-boundary-send-failure',
        autoSchedule: false,
        benchmarkToken: BENCHMARK_TOKEN,
    })
    try
    {
        room.ensureRuntime()
        seedBenchmarkMetrics(room)
        room.safeSend = () => false

        await room.acceptBenchmarkSummary({}, encodeBenchmarkSummaryRequest({
            tokenDigest: await digestBenchmarkToken(BENCHMARK_TOKEN),
        }))

        const after = room.metrics.readBenchmarkSummary()
        assert.equal(after.ticks, 1)
        assert.equal(after.phases.totalTick.maxMs, 20)
        assert.equal(after.scheduler.overloadCallbacks, 1)
        assert.equal(after.disconnects, 1)
    }
    finally
    {
        await room.destroy()
    }
})
