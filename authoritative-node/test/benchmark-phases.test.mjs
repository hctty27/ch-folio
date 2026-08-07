import assert from 'node:assert/strict'
import test from 'node:test'

import { BenchmarkNodeAuthoritativeRoom } from '../src/BenchmarkNodeAuthoritativeRoom.js'

const BENCHMARK_TOKEN = 'benchmark-token-0123456789abcdef0123456789abcdef'

const REQUIRED_PHASES = [
    'simulationBookkeeping',
    'simulationBookkeepingCpu',
    'authoritativeWorld',
    'authoritativeWorldCpu',
    'authoritativeController',
    'authoritativeControllerCpu',
    'authoritativeRuntimeUpdate',
    'authoritativeRuntimeUpdateCpu',
    'rapierStep',
    'rapierStepCpu',
    'stateRead',
    'stateReadCpu',
    'stateEncode',
    'stateEncodeCpu',
    'stateSocketSend',
    'stateSocketSendCpu',
]

test('benchmark room records wall and CPU timing for simulation and state broadcast subphases', async () =>
{
    const room = new BenchmarkNodeAuthoritativeRoom({
        room: 'benchmark-subphases',
        autoSchedule: false,
        benchmarkToken: BENCHMARK_TOKEN,
    })

    try
    {
        room.ensureRuntime()
        const grant = await room.sessions.createSession({
            room: room.room,
            currentTick: room.currentTick,
        })
        assert.ok(grant)
        const reserved = room.simulation.reserveSlot({ playerId: grant.playerId })
        assert.equal(reserved.entityOrder, grant.entityOrder)
        room.simulation.markSyncReady(grant.entityOrder)

        for(let tick = 0; tick < 60; tick++)
            room.advanceOneTick()

        const summary = room.metrics.readBenchmarkSummary()
        for(const phase of REQUIRED_PHASES)
        {
            assert.equal(summary.phases[phase].count, 60, `${phase} count`)
            assert.ok(Number.isFinite(summary.phases[phase].maxMs), `${phase} maxMs`)
            assert.ok(summary.phases[phase].maxMs >= 0, `${phase} non-negative`)
        }

        assert.ok(
            summary.phases.simulationAdvance.totalMs
            >= summary.phases.authoritativeWorld.totalMs,
        )
        assert.ok(
            summary.phases.authoritativeWorld.totalMs
            >= summary.phases.rapierStep.totalMs,
        )
    }
    finally
    {
        await room.destroy()
    }
})
