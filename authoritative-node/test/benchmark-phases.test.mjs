import assert from 'node:assert/strict'
import test from 'node:test'

import { BenchmarkNodeAuthoritativeRoom } from '../src/BenchmarkNodeAuthoritativeRoom.js'

const BENCHMARK_TOKEN = 'benchmark-token-0123456789abcdef0123456789abcdef'

const REQUIRED_PHASES = [
    'simulationBookkeeping',
    'simulationBookkeepingCpu',
    'authoritativeControllerUpdate',
    'authoritativeControllerUpdateCpu',
    'rapierStep',
    'rapierStepCpu',
    'stateRead',
    'stateReadCpu',
    'stateEncode',
    'stateEncodeCpu',
    'stateSocketSend',
    'stateSocketSendCpu',
    'stateSocketSendCallTotal',
    'stateSocketSendCallMax',
    'stateSocketSendLoopOverhead',
    'stateBroadcastUnaccounted',
]

const REQUIRED_DIAGNOSTICS = [
    'totalTickCpuMs',
    'totalTickVoluntaryContextSwitches',
    'totalTickInvoluntaryContextSwitches',
    'stateBroadcastCpuMs',
    'stateBroadcastVoluntaryContextSwitches',
    'stateBroadcastInvoluntaryContextSwitches',
]

test('benchmark room records wall, CPU, send-call, and scheduling diagnostics', async () =>
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

        let sendCount = 0
        const socket = {
            readyState: 1,
            send()
            {
                sendCount++
            },
        }
        room.sockets.add(socket)
        room.attachments.set(socket, {
            handshake: 'session_active',
            playerId: grant.playerId,
            generation: grant.generation,
        })

        for(let tick = 0; tick < 60; tick++)
            room.advanceOneTick()

        room.sockets.delete(socket)
        room.attachments.delete(socket)
        assert.equal(sendCount, 20)

        const summary = room.metrics.readBenchmarkSummary()
        for(const phase of REQUIRED_PHASES)
        {
            assert.equal(summary.phases[phase].count, 60, `${phase} count`)
            assert.ok(Number.isFinite(summary.phases[phase].maxMs), `${phase} maxMs`)
            assert.ok(summary.phases[phase].maxMs >= 0, `${phase} non-negative`)
        }

        for(const slowTick of summary.slowTicks)
        {
            for(const diagnostic of REQUIRED_DIAGNOSTICS)
            {
                assert.ok(
                    Number.isFinite(slowTick.diagnostics[diagnostic]),
                    `${diagnostic} finite on tick ${slowTick.tick}`,
                )
                assert.ok(
                    slowTick.diagnostics[diagnostic] >= 0,
                    `${diagnostic} non-negative on tick ${slowTick.tick}`,
                )
            }
            assert.ok(Number.isSafeInteger(
                slowTick.diagnostics.totalTickVoluntaryContextSwitches,
            ))
            assert.ok(Number.isSafeInteger(
                slowTick.diagnostics.totalTickInvoluntaryContextSwitches,
            ))
            assert.ok(Number.isSafeInteger(
                slowTick.diagnostics.stateBroadcastVoluntaryContextSwitches,
            ))
            assert.ok(Number.isSafeInteger(
                slowTick.diagnostics.stateBroadcastInvoluntaryContextSwitches,
            ))
        }

        assert.ok(
            summary.phases.simulationAdvance.totalMs
            >= summary.phases.rapierStep.totalMs,
        )
        assert.ok(
            summary.phases.simulationNonRapier.totalMs
            >= summary.phases.simulationBookkeeping.totalMs,
        )
        assert.ok(
            summary.phases.simulationNonRapier.totalMs
            >= summary.phases.authoritativeControllerUpdate.totalMs,
        )
        assert.ok(
            summary.phases.stateSocketSend.totalMs
            >= summary.phases.stateSocketSendCallTotal.totalMs,
        )
        assert.ok(
            summary.phases.stateSocketSendCallTotal.totalMs
            >= summary.phases.stateSocketSendCallMax.totalMs,
        )
        assert.ok(
            summary.phases.stateBroadcast.totalMs
            >= summary.phases.stateBroadcastUnaccounted.totalMs,
        )
    }
    finally
    {
        await room.destroy()
    }
})
