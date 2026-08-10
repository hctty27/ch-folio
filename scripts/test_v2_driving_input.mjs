import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    AuthoritativeWorld,
    ROOM_SLOT_STATES,
    RoomSimulation,
    quantizeInput,
} from '@ch-folio/authoritative-physics'
import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'

const RAPIER = await loadRapierForNode()
const mapData = JSON.parse(await readFile(
    new URL('../packages/authoritative-physics/generated/map-v1.json', import.meta.url),
    'utf8',
))

function input(tick, throttle)
{
    return quantizeInput({
        clientTick: tick,
        sequence: tick,
        throttle,
        brake: 0,
        steering: 0,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    })
}

function horizontalDistance(before, after)
{
    return Math.hypot(after[0] - before[0], after[2] - before[2])
}

test('v2 prediction moves the local vehicle under sustained forward input', () =>
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.add(1, mapData.spawns[0])

    for(let tick = 1; tick <= 60; tick++)
    {
        prediction.step({
            inputs: [ { entityOrder: 1, input: input(tick, 0) } ],
        })
    }

    const before = prediction.readState(1).position
    for(let tick = 61; tick <= 180; tick++)
    {
        prediction.step({
            inputs: [ { entityOrder: 1, input: input(tick, 1) } ],
        })
    }
    const after = prediction.readState(1).position

    assert.ok(
        horizontalDistance(before, after) > 0.5,
        `expected forward input to move the car`,
    )
    prediction.destroy()
})

test('authoritative room keeps driving usable with four ticks of input latency', () =>
{
    const world = new AuthoritativeWorld({ RAPIER, mapData })
    const room = new RoomSimulation({ world, mapData })
    const reserved = room.reserveSlot({ playerId: 1 })
    room.markSyncReady(reserved.entityOrder)
    while(room.getSlot(reserved.entityOrder).slotState !== ROOM_SLOT_STATES.ACTIVE)
        room.advanceOneTick()

    const before = world.readVehicleState(reserved.entityOrder).position
    const deliveries = new Map()
    const pending = []
    const latencyTicks = 4

    for(let frame = 1; frame <= 180; frame++)
    {
        const clientTick = (room.currentTick + 1) >>> 0
        pending.push(input(clientTick, 1))

        if(pending.length === 3)
        {
            const deliveryFrame = frame + latencyTicks
            deliveries.set(deliveryFrame, pending.splice(0))
        }

        for(const queued of deliveries.get(frame) ?? [])
            room.queueInput(reserved.entityOrder, queued)

        room.advanceOneTick()
    }

    const after = world.readVehicleState(reserved.entityOrder).position
    const distance = horizontalDistance(before, after)

    assert.ok(distance > 0.5, `expected delayed forward input to move the car, moved ${distance}m`)
    world.destroy()
})
