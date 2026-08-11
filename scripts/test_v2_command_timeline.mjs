import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    FRAME_HEADER_BYTES,
    INPUT_RECORD_BYTES,
    ROOM_SLOT_STATES,
    RoomSimulation,
    decodeInputBatch,
} from '@ch-folio/authoritative-physics'
import {
    InputPublisher,
    commandTickForPredictionTick,
} from '../sources/Game/MultiplayerV2/InputPublisher.js'
import { PredictionInputHistory } from '../sources/Game/MultiplayerV2/PredictionInputHistory.js'

const mapData = JSON.parse(await readFile(
    new URL('../packages/authoritative-physics/generated/map-v1.json', import.meta.url),
    'utf8',
))

function fakeGame()
{
    return {
        player: {
            accelerating: 1,
            braking: 0,
            steering: 0,
            suspensions: [ 'low', 'low', 'low', 'low' ],
            boosting: false,
            honking: false,
        },
    }
}

class FakeWorld
{
    constructor(tick = 99)
    {
        this.tick = tick >>> 0
        this.mapData = mapData
        this.RAPIER = {}
        this.world = {}
        this.vehicles = new Set()
        this.inputApplications = []
    }

    addVehicle(entityOrder)
    {
        this.vehicles.add(entityOrder)
    }

    removeVehicle(entityOrder)
    {
        this.vehicles.delete(entityOrder)
    }

    setInput(entityOrder, input)
    {
        this.inputApplications.push({
            entityOrder,
            serverTick: (this.tick + 1) >>> 0,
            input: { ...input },
        })
    }

    step()
    {
        this.tick = (this.tick + 1) >>> 0
        return this.tick
    }

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

    takeSnapshot()
    {
        return new Uint8Array()
    }
}

function createActiveRoom()
{
    const world = new FakeWorld()
    const room = new RoomSimulation({
        world,
        mapData,
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
    return { room, world, entityOrder: reserved.entityOrder }
}

test('prediction tick P serializes command P-3 and Node consumes it on physical tick P', () =>
{
    const history = []
    const { room, world, entityOrder } = createActiveRoom()
    const predictionTick = (room.currentTick + 3) >>> 0
    const publisher = new InputPublisher(fakeGame(), {
        entityOrder,
        isActive: () => true,
        recordPredictionInput: (record) => history.push(record),
    })

    const input = publisher.sample(predictionTick)
    assert.equal(input.clientTick, room.currentTick)
    assert.equal(history[0].predictionTick, predictionTick)
    assert.equal(history[0].input.clientTick, room.currentTick)

    room.queueInput(entityOrder, input)
    room.advanceOneTick()
    room.advanceOneTick()
    room.advanceOneTick()

    const application = world.inputApplications.find((entry) =>
        entry.input.clientTick === input.clientTick
        && entry.input.throttle === input.throttle)
    assert.equal(application?.serverTick, predictionTick)
    assert.equal(room.lateInputCount, 0)
})

test('prediction-to-command mapping is wrap-safe', () =>
{
    assert.equal(commandTickForPredictionTick(1), 0xfffffffe)
    assert.equal(commandTickForPredictionTick(0), 0xfffffffd)
})

test('successful batches keep protocol layout and report physical prediction records', () =>
{
    const frames = []
    const sentBatches = []
    const publisher = new InputPublisher(fakeGame(), {
        entityOrder: 2,
        isActive: () => true,
        sendFrame: (frame) => { frames.push(frame); return true },
        onBatchSent: (records, sentAtMs) => sentBatches.push({ records, sentAtMs }),
        now: () => 1234,
    })

    publisher.sample(20)
    publisher.sample(21)
    publisher.sample(22)

    assert.equal(frames.length, 1)
    assert.equal(frames[0].byteLength, FRAME_HEADER_BYTES + 3 * INPUT_RECORD_BYTES)
    assert.deepEqual(decodeInputBatch(frames[0]).map((input) => input.clientTick), [ 17, 18, 19 ])
    assert.deepEqual(sentBatches[0].records.map((record) => record.predictionTick), [ 20, 21, 22 ])
    assert.equal(sentBatches[0].sentAtMs, 1234)
})

test('batch sent callback fires only after sendFrame succeeds', () =>
{
    const sentBatches = []
    const publisher = new InputPublisher(fakeGame(), {
        entityOrder: 1,
        isActive: () => true,
        sendFrame: () => false,
        onBatchSent: (records) => sentBatches.push(records),
    })

    publisher.sample(10)
    publisher.sample(11)
    publisher.sample(12)
    assert.equal(sentBatches.length, 0)

    publisher.sendFrame = () => true
    assert.equal(publisher.flush(), true)
    assert.equal(sentBatches.length, 1)
})

test('publisher acknowledgement remains correct across sequence wrap', () =>
{
    const publisher = new InputPublisher(fakeGame(), {
        entityOrder: 1,
        isActive: () => true,
        sendFrame: () => false,
    })
    publisher.sequence = 0xfffffffe

    publisher.sample(10)
    publisher.sample(11)
    publisher.sample(12)
    publisher.sample(13)

    assert.equal(publisher.acknowledge(1), 3)
    assert.deepEqual(publisher.unacknowledgedInputs.map((input) => input.sequence), [ 1 ])
    assert.deepEqual(publisher.pendingInputs.map((input) => input.sequence), [ 1 ])
})

test('prediction input history queries and acknowledges across uint32 wrap', () =>
{
    const history = new PredictionInputHistory(8)
    for(const [ predictionTick, sequence ] of [
        [ 0xfffffffe, 0xfffffffe ],
        [ 0xffffffff, 0xffffffff ],
        [ 0, 0 ],
        [ 1, 1 ],
    ])
    {
        history.push({
            predictionTick,
            entityOrder: 1,
            input: {
                clientTick: (predictionTick - 3) >>> 0,
                sequence,
                throttle: 255,
                brake: 0,
                steering: 0,
                suspensions: 0,
                flags: 0,
            },
        })
    }

    assert.equal(history.atPredictionTick(0)?.input.sequence, 0)
    assert.deepEqual(
        history.afterPredictionTick(0xffffffff).map((record) => record.predictionTick),
        [ 0, 1 ],
    )
    assert.equal(history.acknowledge(1), 3)
    assert.deepEqual(history.values().map((record) => record.input.sequence), [ 1 ])
    history.clear()
    assert.equal(history.size, 0)
})
