import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ProtocolError,
    encodeFullSyncFrame,
    encodeStateFrame,
} from '../src/index.js'

function state(entityOrder)
{
    return {
        entityOrder,
        stateFlags: 0,
        collisionFlags: 0,
        suspensions: 0,
        lastConfirmedSequence: 0,
        position: [ 0, 0, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
        linearVelocity: [ 0, 0, 0 ],
        angularVelocity: [ 0, 0, 0 ],
        steering: 0,
        wheelRotations: [ 0, 0, 0, 0 ],
        controlFlags: 0,
        throttle: 128,
        brake: 0,
        inputFlags: 0,
    }
}

function entity(entityOrder)
{
    return {
        entityOrder,
        slotState: 1,
        spawnIndex: entityOrder,
        flags: 0,
        playerId: 100 + entityOrder,
        lastConfirmedSequence: 0,
        controllerOffset: 0,
        controllerLength: 0,
    }
}

function input(clientTick, sequence)
{
    return {
        clientTick,
        sequence,
        throttle: 128,
        brake: 0,
        steering: 0,
        suspensions: 0,
        flags: 0,
    }
}

test('state frames require strictly increasing entityOrder', () =>
{
    assert.throws(
        () => encodeStateFrame({
            serverTick: 1,
            eventCursor: 0,
            checksum32: 0,
            states: [ state(1), state(0) ],
            events: [],
        }),
        (error) => error instanceof ProtocolError && /sorted entityOrder/.test(error.message),
    )
})

test('full sync requires ordered descriptors and canonical queued-input order', () =>
{
    const base = {
        checkpointTick: 1,
        serverTick: 2,
        eventCursor: 0,
        checksum32: 0,
        snapshot: new Uint8Array([ 1 ]),
        controllerMetadata: new Uint8Array(),
    }

    assert.throws(
        () => encodeFullSyncFrame({
            ...base,
            entities: [ entity(1), entity(0) ],
            queuedInputs: [],
        }),
        (error) => error instanceof ProtocolError && /sorted entityOrder/.test(error.message),
    )

    assert.throws(
        () => encodeFullSyncFrame({
            ...base,
            entities: [ entity(0), entity(1) ],
            queuedInputs: [
                { entityOrder: 1, input: input(5, 1) },
                { entityOrder: 0, input: input(5, 1) },
            ],
        }),
        (error) => error instanceof ProtocolError && /queued inputs.*canonical order/i.test(error.message),
    )
})
