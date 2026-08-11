import assert from 'node:assert/strict'
import test from 'node:test'

import { BenchmarkNodeAuthoritativeRoom } from '../src/BenchmarkNodeAuthoritativeRoom.js'

const BENCHMARK_TOKEN = 'benchmark-token-0123456789abcdef0123456789abcdef'

const FINITE_FIELDS = [
    'intervalWallMs',
    'intervalCpuMs',
    'intervalMainThreadCpuMs',
    'voluntaryContextSwitches',
    'involuntaryContextSwitches',
    'eventLoopActiveMs',
    'eventLoopIdleMs',
    'eventLoopUtilization',
]

test('benchmark scheduler records overload callback evidence and reset clears it', async () =>
{
    const room = new BenchmarkNodeAuthoritativeRoom({
        room: 'scheduler-overload-diagnostics',
        autoSchedule: false,
        benchmarkToken: BENCHMARK_TOKEN,
    })
    try
    {
        room.scheduler.onCallback(4, 3)

        const summary = room.metrics.readBenchmarkSummary()
        assert.equal(summary.scheduler.overloadCallbacks, 1)
        assert.equal(summary.schedulerOverloads.length, 1)

        const [ diagnostic ] = summary.schedulerOverloads
        assert.equal(diagnostic.dueTicks, 4)
        assert.equal(diagnostic.executedTicks, 3)
        assert.equal(diagnostic.currentTick, 0)
        for(const field of FINITE_FIELDS)
        {
            assert.equal(Number.isFinite(diagnostic[field]), true, `${field} must be finite`)
            assert.ok(diagnostic[field] >= 0, `${field} must be non-negative`)
        }
        assert.ok(diagnostic.intervalMainThreadCpuMs <= diagnostic.intervalCpuMs + 0.5)
        assert.ok(diagnostic.eventLoopUtilization <= 1)

        room.metrics.resetBenchmark()
        assert.deepEqual(room.metrics.readBenchmarkSummary().schedulerOverloads, [])
    }
    finally
    {
        await room.destroy()
    }
})
