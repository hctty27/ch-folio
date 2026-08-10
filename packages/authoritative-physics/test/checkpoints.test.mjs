import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
    CheckpointRing,
    InputHistory,
    checksum32,
    hashWorldSnapshot,
    readCanonicalState,
} from '../src/index.js'

function state(entityOrder, overrides = {})
{
    return {
        entityOrder,
        stateFlags: 2,
        collisionFlags: 3,
        suspensions: 0x24,
        lastConfirmedSequence: 0x01020304,
        position: [ 1.25, -2.5, 3.75 ],
        quaternion: [ 0, 0, 0, 1 ],
        linearVelocity: [ 4.5, -5.25, 6 ],
        angularVelocity: [ 0.125, 0.25, 0.5 ],
        steering: -1234,
        wheelRotations: [ 100, -200, 300, -400 ],
        controlFlags: 0x1234,
        throttle: 200,
        brake: 55,
        inputFlags: 3,
        ...overrides,
    }
}

function input(clientTick, entityOrder, sequence = clientTick)
{
    return {
        entityOrder,
        input: {
            clientTick,
            sequence,
            throttle: 128,
            brake: 0,
            steering: entityOrder === 1 ? 100 : -100,
            suspensions: 0x24,
            flags: 0,
        },
    }
}

test('canonical state sorts entities, frounds physical values, and excludes runtime-only data', () =>
{
    const raw = [
        state(2, {
            position: [ 2.00000006, 4.00000012, 6.00000024 ],
            timestamp: 123456,
            bodyHandle: 99,
            socket: { id: 'not-canonical' },
            visualOffset: [ 10, 20, 30 ],
        }),
        state(1, {
            position: [ 1.00000006, 3.00000012, 5.00000024 ],
        }),
    ]

    const canonical = readCanonicalState(raw)

    assert.deepEqual(canonical.map((record) => record.entityOrder), [ 1, 2 ])
    assert.deepEqual(canonical[0].position, raw[1].position.map(Math.fround))
    assert.deepEqual(canonical[1].position, raw[0].position.map(Math.fround))
    assert.deepEqual(Object.keys(canonical[0]), [
        'entityOrder',
        'stateFlags',
        'collisionFlags',
        'suspensions',
        'lastConfirmedSequence',
        'position',
        'quaternion',
        'linearVelocity',
        'angularVelocity',
        'steering',
        'wheelRotations',
        'controlFlags',
        'throttle',
        'brake',
        'inputFlags',
    ])
    assert.equal('timestamp' in canonical[1], false)
    assert.equal('bodyHandle' in canonical[1], false)
    assert.equal('socket' in canonical[1], false)
    assert.equal('visualOffset' in canonical[1], false)

    raw[1].position[0] = 999
    assert.equal(canonical[0].position[0], Math.fround(1.00000006))

    assert.throws(
        () => readCanonicalState([ state(1), state(1) ]),
        /duplicate entityOrder 1/,
    )
    assert.throws(
        () => readCanonicalState([ state(1, {
            position: [ Number.MAX_VALUE, 0, 0 ],
        }) ]),
        /finite float32/,
    )
})

test('checksum32 uses stable FNV-1a over the fixed canonical record layout', () =>
{
    assert.equal(checksum32([ state(1) ]), 0x54b23e53)
    assert.equal(checksum32([ state(2), state(1) ]), checksum32([ state(1), state(2) ]))
})

test('hashWorldSnapshot returns a stable asynchronous SHA-256 digest of captured bytes', async () =>
{
    const source = Uint8Array.from([ 0, 1, 2, 3, 254, 255 ])
    const captured = source.slice()
    const expected = new Uint8Array(createHash('sha256').update(captured).digest())

    const pending = hashWorldSnapshot(source)
    assert.ok(pending instanceof Promise)

    source.fill(17)
    const digest = await pending

    assert.deepEqual(digest, expected)
    assert.equal(digest.byteLength, 32)
})

test('CheckpointRing retains thirty immutable checkpoints and finds the nearest prior tick', () =>
{
    const ring = new CheckpointRing()

    for(let tick = 0; tick < 35; tick++)
    {
        const snapshot = Uint8Array.from([ tick, tick + 1 ])
        const controllerMetadata = Uint8Array.from([ tick + 2 ])

        ring.push({
            tick,
            snapshot,
            entities: [ {
                entityOrder: 1,
                slotState: 2,
                spawnIndex: 3,
                flags: 4,
                playerId: 5,
                lastConfirmedSequence: tick,
                controllerOffset: 0,
                controllerLength: 1,
            } ],
            controllerMetadata,
            confirmedSequences: [ { entityOrder: 1, sequence: tick } ],
            eventCursor: tick * 2,
        })

        snapshot[0] = 255
        controllerMetadata[0] = 255
    }

    assert.equal(ring.size, 30)
    assert.equal(ring.oldest().tick, 5)
    assert.equal(ring.latest().tick, 34)
    assert.equal(ring.findAtOrBefore(17).tick, 17)
    assert.equal(ring.findAtOrBefore(4), null)
    assert.deepEqual(ring.oldest().snapshot, Uint8Array.from([ 5, 6 ]))
    assert.deepEqual(ring.latest().controllerMetadata, Uint8Array.from([ 36 ]))

    const exposed = ring.latest()
    exposed.snapshot[0] = 200
    exposed.entities[0].playerId = 999
    assert.deepEqual(ring.latest().snapshot, Uint8Array.from([ 34, 35 ]))
    assert.equal(ring.latest().entities[0].playerId, 5)

    assert.throws(() => ring.push({
        ...ring.latest(),
        tick: 34,
    }), /strictly increasing/)
})

test('InputHistory retains every entity input for the latest sixty ticks in canonical order', () =>
{
    const history = new InputHistory()

    for(let tick = 1; tick <= 65; tick++)
    {
        assert.equal(history.push(input(tick, 2, tick * 2)), true)
        assert.equal(history.push(input(tick, 1, tick * 2 - 1)), true)
    }

    assert.equal(history.tickCount, 60)
    assert.equal(history.size, 120)
    assert.equal(history.oldestTick, 6)
    assert.equal(history.latestTick, 65)

    const records = history.values()
    assert.deepEqual(records.slice(0, 4).map((record) => [
        record.input.clientTick,
        record.entityOrder,
        record.input.sequence,
    ]), [
        [ 6, 1, 11 ],
        [ 6, 2, 12 ],
        [ 7, 1, 13 ],
        [ 7, 2, 14 ],
    ])

    assert.equal(history.push(input(5, 1, 999)), false)
    assert.equal(history.push(input(65, 1, 129)), false)
    assert.deepEqual(
        history.after(63).map((record) => record.input.clientTick),
        [ 64, 64, 65, 65 ],
    )

    records[0].input.throttle = 255
    assert.equal(history.values()[0].input.throttle, 128)
})
