import assert from 'node:assert/strict'
import test from 'node:test'

import { quantizeInput } from '@ch-folio/authoritative-physics'
import { NodeAuthoritativeRoom } from '../src/NodeAuthoritativeRoom.js'

test('live Node room publishes bounded future queue diagnostics every tick', async () =>
{
    const room = new NodeAuthoritativeRoom({
        room: 'future-queue-metrics',
        autoSchedule: false,
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

        for(let tick = 0; tick < 4; tick++)
            room.advanceOneTick()

        const commandTick = (room.currentTick + 8) >>> 0
        assert.equal(room.simulation.queueInput(grant.entityOrder, quantizeInput({
            clientTick: commandTick,
            sequence: 1,
            throttle: 1,
            brake: 0,
            steering: 0,
            suspensions: [ 'low', 'low', 'low', 'low' ],
            boosting: false,
            honking: false,
        })), true)

        room.advanceOneTick()
        const summary = room.metrics.readBenchmarkSummary()
        assert.ok(summary.gauges.futureInputCount > 0)
        assert.ok(summary.gauges.futureInputCountMax >= summary.gauges.futureInputCount)
        assert.ok(summary.gauges.futureLeadMaxTicks > 0)
        assert.ok(summary.gauges.futureLeadMaxTicks <= 18)
        assert.equal(summary.gauges.staleInputMax, 0)
        assert.equal(summary.gauges.persistentFutureQueueGrowth, false)
    }
    finally
    {
        await room.destroy()
    }
})