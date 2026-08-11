import assert from 'node:assert/strict'
import test from 'node:test'

import { ROOM_EVENT_TYPES } from '@ch-folio/authoritative-physics'
import { RemoteSnapshotBuffer } from '../sources/Game/MultiplayerV2/RemoteSnapshotBuffer.js'
import { VehicleVisuals } from '../sources/Game/MultiplayerV2/VehicleVisuals.js'

function stateAtX(x, overrides = {})
{
    return {
        entityOrder: 2,
        stateFlags: 3,
        collisionFlags: 0,
        suspensions: 0,
        lastConfirmedSequence: 0,
        position: [ x, 0, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
        linearVelocity: [ 60, 0, 0 ],
        angularVelocity: [ 0, 0, 0 ],
        steering: x / 10,
        wheelRotations: [ x, x + 1, x + 2, x + 3 ],
        controlFlags: 0,
        throttle: 128,
        brake: 0,
        inputFlags: 0,
        ...overrides,
    }
}

function frame(serverTick, states, events = [])
{
    return {
        serverTick,
        eventCursor: 0,
        checksum32: 0,
        states,
        events,
        worldHash: null,
    }
}

test('20Hz remote snapshots interpolate every 60Hz simulation tick', () =>
{
    const buffer = new RemoteSnapshotBuffer()
    buffer.push(100, stateAtX(0))
    buffer.push(103, stateAtX(3))

    assert.equal(buffer.sample(101).position[0], 1)
    assert.equal(buffer.sample(102).position[0], 2)
    assert.ok(Math.abs(buffer.sample(101).steering - 0.1) < 1e-12)
    assert.deepEqual(buffer.sample(102).wheelRotations, [ 2, 3, 4, 5 ])
})

test('out-of-order remote snapshots do not reverse interpolation time', () =>
{
    const buffer = new RemoteSnapshotBuffer()
    buffer.push(106, stateAtX(6))
    buffer.push(100, stateAtX(0))
    buffer.push(103, stateAtX(3))

    assert.equal(buffer.sample(104).position[0], 4)
    assert.equal(buffer.sample(105).position[0], 5)
})

test('duplicate ticks replace samples and the buffer retains only the latest 32 ticks', () =>
{
    const buffer = new RemoteSnapshotBuffer()
    for(let tick = 1; tick <= 40; tick++)
        buffer.push(tick, stateAtX(tick))
    buffer.push(40, stateAtX(400))

    assert.equal(buffer.size, 32)
    assert.equal(buffer.sample(40).position[0], 400)
    assert.equal(buffer.sample(1).position[0], 9)
})

test('quaternion interpolation uses the shortest path', () =>
{
    const half = Math.PI / 4
    const buffer = new RemoteSnapshotBuffer()
    buffer.push(10, stateAtX(0, { quaternion: [ 0, 0, 0, 1 ] }))
    buffer.push(12, stateAtX(2, {
        quaternion: [ 0, -Math.sin(half), 0, -Math.cos(half) ],
    }))

    const quaternion = buffer.sample(11).quaternion
    assert.ok(Math.abs(quaternion[1] - Math.sin(Math.PI / 8)) < 1e-12)
    assert.ok(Math.abs(quaternion[3] - Math.cos(Math.PI / 8)) < 1e-12)
})

test('remote extrapolation uses velocity for at most three ticks then holds', () =>
{
    const buffer = new RemoteSnapshotBuffer()
    buffer.push(100, stateAtX(10, { linearVelocity: [ 60, 0, 0 ] }))

    assert.equal(buffer.sample(101).position[0], 11)
    assert.equal(buffer.sample(103).position[0], 13)
    assert.equal(buffer.sample(104).position[0], 10)
})

test('vehicle visuals render local prediction and remote buffers without mutating PredictionWorld', () =>
{
    const mutations = []
    const localState = {
        ...stateAtX(1, { entityOrder: 1, linearVelocity: [ 0, 0, 0 ] }),
        wheelContacts: [],
    }
    const predictionWorld = {
        mutations,
        readState(entityOrder)
        {
            assert.equal(entityOrder, 1)
            return structuredClone(localState)
        },
    }
    const local = {
        states: [],
        setExternalSimulation() {},
        applyExternalState(state) { this.states.push(structuredClone(state)) },
    }
    const remotes = []
    class FakeRemoteVehicle
    {
        constructor(game, entityOrder, template, options)
        {
            void game
            void template
            assert.deepEqual(options, { mode: 'authoritative' })
            this.entityOrder = entityOrder
            this.states = []
            remotes.push(this)
        }
        applyAuthoritativeState(state) { this.states.push(structuredClone(state)) }
        update() { this.updateCount = (this.updateCount ?? 0) + 1 }
        destroy() { this.destroyed = true }
    }

    const visuals = new VehicleVisuals({
        game: {},
        predictionWorld,
        localEntityOrder: 1,
        physicalVehicle: local,
        vehicleTemplate: {},
        RemoteVehicleClass: FakeRemoteVehicle,
    })
    visuals.acceptAuthoritativeStateFrame(frame(100, [ stateAtX(0) ]))
    visuals.acceptAuthoritativeStateFrame(frame(103, [ stateAtX(3) ]))

    assert.equal(visuals.update(1 / 60, 101), 2)
    assert.equal(local.states[0].position[0], 1)
    assert.equal(remotes.length, 1)
    assert.equal(remotes[0].states[0].position[0], 1)
    assert.deepEqual(mutations, [])

    visuals.acceptAuthoritativeStateFrame(frame(104, [], [ {
        tick: 104,
        type: ROOM_EVENT_TYPES.DESPAWN,
        entityOrder: 2,
        spawnIndex: 0xff,
        flags: 0,
        value: 0,
    } ]))
    assert.equal(remotes[0].destroyed, true)
    assert.equal(visuals.remoteBuffers.has(2), false)
    visuals.destroy()
})
