import assert from 'node:assert/strict'
import test from 'node:test'

import {
    INPUT_BUFFER_TICKS,
    ROOM_SLOT_STATES,
    RoomSimulation,
    quantizeInput,
} from '../src/index.js'

class FakeWorld
{
    constructor()
    {
        this.tick = 0
        this.vehicles = new Set()
        this.RAPIER = {}
        this.world = {}
    }

    addVehicle(entityOrder) { this.vehicles.add(entityOrder) }
    removeVehicle(entityOrder) { this.vehicles.delete(entityOrder) }
    setInput() {}
    step() { this.tick++ }
    readVehicleState(entityOrder)
    {
        return {
            entityOrder,
            position: [ 0, 0, 0 ],
            quaternion: [ 0, 0, 0, 1 ],
            linearVelocity: [ 0, 0, 0 ],
            angularVelocity: [ 0, 0, 0 ],
            confirmedInputSequence: 0,
        }
    }
    takeSnapshot() { return new Uint8Array() }
}

function createActiveRoom()
{
    const room = new RoomSimulation({
        world: new FakeWorld(),
        mapData: {
            mapCollisionVersion: 1,
            spawns: [ { position: [ 0, 0, 0 ], quaternion: [ 0, 0, 0, 1 ] } ],
        },
        findSpawn: () => ({
            index: 0,
            position: [ 0, 0, 0 ],
            quaternion: [ 0, 0, 0, 1 ],
        }),
    })
    const reserved = room.reserveSlot({ playerId: 1 })
    room.markSyncReady(reserved.entityOrder)
    while(room.getSlot(reserved.entityOrder).slotState !== ROOM_SLOT_STATES.ACTIVE)
        room.advanceOneTick()
    return { room, entityOrder: reserved.entityOrder }
}

function input(clientTick, sequence)
{
    return quantizeInput({
        clientTick,
        sequence,
        throttle: 1,
        brake: 0,
        steering: 0,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    })
}

test('future commands are bounded health, not persistent backlog', () =>
{
    const { room, entityOrder } = createActiveRoom()
    assert.equal(INPUT_BUFFER_TICKS, 3)

    while(room.getSlot(entityOrder).lastConsumedInputTick === null)
        room.advanceOneTick()
    const consumed = room.getSlot(entityOrder).lastConsumedInputTick
    for(let lead = 1; lead <= 12; lead++)
        assert.equal(room.queueInput(entityOrder, input((consumed + lead) >>> 0, lead)), true)

    const diagnostics = room.inputQueueDiagnostics()
    assert.equal(diagnostics.futureInputCount, 12)
    assert.equal(diagnostics.futureLeadMaxTicks, 12)
    assert.equal(diagnostics.staleInputCount, 0)
    assert.equal(diagnostics.lateInputCount, 0)
})

test('completed ticks remove stale queued entries while preserving valid future commands', () =>
{
    const { room, entityOrder } = createActiveRoom()
    while(room.getSlot(entityOrder).lastConsumedInputTick === null)
        room.advanceOneTick()
    const consumed = room.getSlot(entityOrder).lastConsumedInputTick
    room.queueInput(entityOrder, input((consumed + 1) >>> 0, 1))
    room.queueInput(entityOrder, input((consumed + 8) >>> 0, 8))

    room.advanceOneTick()
    const diagnostics = room.inputQueueDiagnostics()
    assert.equal(diagnostics.staleInputCount, 0)
    assert.ok(diagnostics.futureInputCount > 0)
    assert.ok(diagnostics.futureLeadMaxTicks <= 18)
})