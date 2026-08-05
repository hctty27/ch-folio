import assert from 'node:assert/strict'
import test from 'node:test'

import {
    FRAME_HEADER_BYTES,
    FRAME_TYPES,
    INPUT_RECORD_BYTES,
    ProtocolError,
    STATE_RECORD_BYTES,
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeHello,
    decodeInputBatch,
    decodeResume,
    decodeStateFrame,
    encodeErrorFrame,
    encodeFullSyncFrame,
    encodeHello,
    encodeInputBatch,
    encodeResume,
    encodeStateFrame,
} from '../src/protocol.js'

const INPUT = Object.freeze({
    clientTick: 0x01020304,
    sequence: 0x05060708,
    throttle: 255,
    brake: 64,
    steering: -1234,
    suspensions: 36,
    flags: 3,
})

const STATE = Object.freeze({
    entityOrder: 2,
    stateFlags: 5,
    collisionFlags: 3,
    suspensions: 36,
    lastConfirmedSequence: 77,
    position: [ 1.25, -2.5, 3.75 ],
    quaternion: [ 0, 0.5, 0, 0.8660254 ],
    linearVelocity: [ 4, 5, 6 ],
    angularVelocity: [ -1, -2, -3 ],
    steering: -2048,
    wheelRotations: [ 100, -200, 300, -400 ],
    controlFlags: 9,
    throttle: 200,
    brake: 10,
    inputFlags: 1,
})

function bytes(values)
{
    return Uint8Array.from(values)
}

function seededBytes(seed, length)
{
    let value = seed >>> 0
    const output = new Uint8Array(length)

    for(let index = 0; index < output.length; index++)
    {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0
        output[index] = value >>> 24
    }

    return output
}

test('one input frame is an 8-byte header plus one 14-byte little-endian record', () =>
{
    const encoded = encodeInputBatch([ INPUT ])

    assert.equal(FRAME_HEADER_BYTES, 8)
    assert.equal(INPUT_RECORD_BYTES, 14)
    assert.equal(encoded.byteLength, 22)

    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    assert.equal(view.getUint8(0), FRAME_TYPES.INPUT_BATCH)
    assert.equal(view.getUint8(1), 1)
    assert.equal(view.getUint16(2, true), 2)
    assert.equal(view.getUint32(4, true), 14)
    assert.equal(view.getUint32(8, true), 0x01020304)
    assert.equal(view.getUint32(12, true), 0x05060708)
    assert.equal(view.getUint8(16), 255)
    assert.equal(view.getUint8(17), 64)
    assert.equal(view.getInt16(18, true), -1234)
    assert.equal(view.getUint8(20), 36)
    assert.equal(view.getUint8(21), 3)
    assert.deepEqual(decodeInputBatch(encoded), [ INPUT ])
})

test('input batches enforce the six-record limit and exact payload length', () =>
{
    assert.throws(
        () => encodeInputBatch(Array.from({ length: 7 }, () => INPUT)),
        (error) => error instanceof ProtocolError && /six/i.test(error.message),
    )

    const encoded = encodeInputBatch([ INPUT ])
    const wrongLength = encoded.slice()
    new DataView(wrongLength.buffer).setUint32(4, 13, true)
    assert.throws(() => decodeInputBatch(wrongLength), ProtocolError)

    const trailing = new Uint8Array(encoded.byteLength + 1)
    trailing.set(encoded)
    assert.throws(() => decodeInputBatch(trailing), ProtocolError)
})

test('hello and resume frames use fixed binary layouts and exact versions', () =>
{
    const hello = encodeHello({ clientTick: 1234 })
    assert.equal(hello.byteLength, 16)
    assert.deepEqual(decodeHello(hello), {
        protocolVersion: 2,
        vehiclePhysicsVersion: 1,
        mapCollisionVersion: 1,
        clientTick: 1234,
    })

    const token = bytes(Array.from({ length: 32 }, (_, index) => index))
    const resume = encodeResume({
        playerId: 0x89abcdef,
        lastServerTick: 55,
        resumeToken: token,
    })
    assert.equal(resume.byteLength, 52)
    assert.deepEqual(decodeResume(resume), {
        protocolVersion: 2,
        vehiclePhysicsVersion: 1,
        mapCollisionVersion: 1,
        playerId: 0x89abcdef,
        lastServerTick: 55,
        resumeToken: token,
    })

    const incompatible = hello.slice()
    new DataView(incompatible.buffer).setUint16(2, 1, true)
    assert.throws(
        () => decodeHello(incompatible),
        (error) => error instanceof ProtocolError && /protocolVersion/.test(error.message),
    )
})

test('state frames encode fixed records, deterministic events, and an optional world hash', () =>
{
    const hash = bytes(Array.from({ length: 32 }, (_, index) => 255 - index))
    const encoded = encodeStateFrame({
        serverTick: 900,
        eventCursor: 12,
        checksum32: 0xdeadbeef,
        states: [ STATE ],
        events: [ {
            type: 1,
            entityOrder: 2,
            spawnIndex: 4,
            flags: 3,
            tick: 901,
            value: 0x12345678,
        } ],
        worldHash: {
            hashTick: 840,
            sha256: hash,
        },
    })

    assert.equal(STATE_RECORD_BYTES, 76)
    assert.equal(encoded.byteLength, 152)
    assert.equal(encoded[1], 0x81)

    const decoded = decodeStateFrame(encoded)
    assert.equal(decoded.serverTick, 900)
    assert.equal(decoded.eventCursor, 12)
    assert.equal(decoded.checksum32, 0xdeadbeef)
    assert.equal(decoded.vehiclePhysicsVersion, 1)
    assert.equal(decoded.mapCollisionVersion, 1)
    assert.deepEqual(decoded.states[0], {
        ...STATE,
        position: STATE.position.map(Math.fround),
        quaternion: STATE.quaternion.map(Math.fround),
        linearVelocity: STATE.linearVelocity.map(Math.fround),
        angularVelocity: STATE.angularVelocity.map(Math.fround),
    })
    assert.deepEqual(decoded.events, [ {
        type: 1,
        entityOrder: 2,
        spawnIndex: 4,
        flags: 3,
        tick: 901,
        value: 0x12345678,
    } ])
    assert.deepEqual(decoded.worldHash, {
        hashTick: 840,
        sha256: hash,
    })
})

test('state frames reject non-finite floats and entity counts above eight', () =>
{
    assert.throws(
        () => encodeStateFrame({
            serverTick: 1,
            eventCursor: 0,
            checksum32: 0,
            states: [ { ...STATE, position: [ Number.NaN, 0, 0 ] } ],
            events: [],
        }),
        (error) => error instanceof ProtocolError && /finite/.test(error.message),
    )

    assert.throws(
        () => encodeStateFrame({
            serverTick: 1,
            eventCursor: 0,
            checksum32: 0,
            states: Array.from({ length: 9 }, (_, entityOrder) => ({ ...STATE, entityOrder })),
            events: [],
        }),
        (error) => error instanceof ProtocolError && /eight/i.test(error.message),
    )
})

test('full sync carries snapshot, ordered descriptors, controller metadata, and queued inputs', () =>
{
    const snapshot = bytes([ 9, 8, 7, 6 ])
    const controllerMetadata = bytes([ 1, 2, 3, 4, 5, 6 ])
    const entities = [
        {
            entityOrder: 0,
            slotState: 2,
            spawnIndex: 1,
            flags: 0,
            playerId: 100,
            lastConfirmedSequence: 20,
            controllerOffset: 0,
            controllerLength: 2,
        },
        {
            entityOrder: 1,
            slotState: 3,
            spawnIndex: 255,
            flags: 1,
            playerId: 101,
            lastConfirmedSequence: 21,
            controllerOffset: 2,
            controllerLength: 4,
        },
    ]
    const queuedInputs = [
        { entityOrder: 0, input: INPUT },
        { entityOrder: 1, input: { ...INPUT, clientTick: 5, sequence: 6 } },
    ]

    const encoded = encodeFullSyncFrame({
        checkpointTick: 500,
        serverTick: 503,
        eventCursor: 22,
        checksum32: 0x10203040,
        snapshot,
        entities,
        controllerMetadata,
        queuedInputs,
    })

    assert.equal(encoded.byteLength, 112)
    assert.deepEqual(decodeFullSyncFrame(encoded), {
        protocolVersion: 2,
        vehiclePhysicsVersion: 1,
        mapCollisionVersion: 1,
        checkpointTick: 500,
        serverTick: 503,
        eventCursor: 22,
        checksum32: 0x10203040,
        snapshot,
        entities,
        controllerMetadata,
        queuedInputs,
    })
})

test('full sync rejects descriptor metadata ranges outside the metadata block', () =>
{
    assert.throws(
        () => encodeFullSyncFrame({
            checkpointTick: 1,
            serverTick: 2,
            eventCursor: 0,
            checksum32: 0,
            snapshot: bytes([ 1 ]),
            entities: [ {
                entityOrder: 0,
                slotState: 1,
                spawnIndex: 0,
                flags: 0,
                playerId: 1,
                lastConfirmedSequence: 0,
                controllerOffset: 1,
                controllerLength: 2,
            } ],
            controllerMetadata: bytes([ 1, 2 ]),
            queuedInputs: [],
        }),
        (error) => error instanceof ProtocolError && /controller metadata/i.test(error.message),
    )
})

test('error frames remain binary and preserve controlled diagnostic text', () =>
{
    const encoded = encodeErrorFrame({
        code: 41,
        retryable: true,
        contextTick: 99,
        message: '版本不兼容',
    })

    assert.equal(encoded[0], FRAME_TYPES.ERROR)
    assert.deepEqual(decodeErrorFrame(encoded), {
        protocolVersion: 2,
        code: 41,
        retryable: true,
        contextTick: 99,
        message: '版本不兼容',
    })
})

test('all decoders turn 1000 seeded malformed buffers into controlled protocol errors', () =>
{
    const decoders = [
        decodeHello,
        decodeResume,
        decodeInputBatch,
        decodeStateFrame,
        decodeFullSyncFrame,
        decodeErrorFrame,
    ]

    for(let seed = 1; seed <= 1000; seed++)
    {
        const candidate = seededBytes(seed, seed % 193)

        for(const decode of decoders)
        {
            try
            {
                decode(candidate)
            }
            catch(error)
            {
                assert.ok(error instanceof ProtocolError, `${decode.name} leaked ${error?.constructor?.name}`)
                assert.notEqual(error?.name, 'RangeError')
            }
        }
    }
})
