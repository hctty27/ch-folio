import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    ROOM_EVENT_TYPES,
    quantizeInput,
} from '@ch-folio/authoritative-physics'
import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'
import { VehicleVisuals } from '../sources/Game/MultiplayerV2/VehicleVisuals.js'

const RAPIER = await loadRapierForNode()
const mapData = JSON.parse(await readFile(
    new URL('../packages/authoritative-physics/generated/map-v1.json', import.meta.url),
    'utf8',
))
const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

function input(clientTick, sequence, steering = 0)
{
    return quantizeInput({
        clientTick,
        sequence,
        throttle: 0.75,
        brake: 0,
        steering,
        suspensions: [ 'low', 'mid', 'high', 'low' ],
        boosting: false,
        honking: false,
    })
}

function normalizedState(state)
{
    return {
        entityOrder: state.entityOrder,
        position: state.position.map(Math.fround),
        quaternion: state.quaternion.map(Math.fround),
        linearVelocity: state.linearVelocity.map(Math.fround),
        angularVelocity: state.angularVelocity.map(Math.fround),
        steering: Math.fround(state.steering),
        lastConfirmedSequence: state.lastConfirmedSequence,
    }
}

test('prediction world uses the generated map and steps room vehicles in entity order', () =>
{
    const prediction = new PredictionWorld({ RAPIER })
    assert.equal(prediction.mapData.mapCollisionVersion, mapData.mapCollisionVersion)
    assert.equal(prediction.mapData.spawns.length, 8)

    prediction.add(2, mapData.spawns[1])
    prediction.add(1, mapData.spawns[0])
    prediction.applyInputs([
        { entityOrder: 2, input: input(1, 22, -0.25) },
        { entityOrder: 1, input: input(1, 11, 0.25) },
    ])

    assert.equal(prediction.step(), 1)
    const states = prediction.readState()
    assert.deepEqual(states.map((state) => state.entityOrder), [ 1, 2 ])
    assert.deepEqual(states.map((state) => state.lastConfirmedSequence), [ 11, 22 ])
    assert.equal(states[0].suspensions, input(1, 11, 0.25).suspensions)
    assert.equal(states[0].wheelContacts.length, 4)

    prediction.destroy()
})

test('prediction world applies spawn and despawn events at their exact ticks', () =>
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.step({
        events: [
            {
                tick: 2,
                type: ROOM_EVENT_TYPES.SPAWN,
                entityOrder: 2,
                spawnIndex: 1,
            },
            {
                tick: 2,
                type: ROOM_EVENT_TYPES.SPAWN,
                entityOrder: 1,
                spawnIndex: 0,
            },
        ],
    })
    assert.equal(prediction.tick, 1)
    assert.deepEqual(prediction.readState(), [])

    prediction.step()
    assert.deepEqual(prediction.readState().map((state) => state.entityOrder), [ 1, 2 ])

    prediction.step({
        events: [ {
            tick: 3,
            type: ROOM_EVENT_TYPES.DESPAWN,
            entityOrder: 1,
            spawnIndex: 0,
        } ],
    })
    assert.equal(prediction.tick, 3)
    assert.deepEqual(prediction.readState().map((state) => state.entityOrder), [ 2 ])

    prediction.destroy()
})

test('prediction world restores a full-room Rapier snapshot and queued inputs', () =>
{
    const source = new PredictionWorld({ RAPIER, mapData })
    source.add(1, mapData.spawns[0])
    source.add(2, mapData.spawns[1])
    source.applyInputs([
        { entityOrder: 1, input: input(1, 101, 0.4) },
        { entityOrder: 2, input: input(1, 202, -0.4) },
    ])
    source.step()
    source.step()

    const expected = source.readState().map(normalizedState)
    const sync = {
        checkpointTick: source.tick,
        serverTick: source.tick,
        eventCursor: 7,
        snapshot: source.world.takeSnapshot(),
        entities: [
            { entityOrder: 1, flags: 1, spawnIndex: 0 },
            { entityOrder: 2, flags: 1, spawnIndex: 1 },
        ],
        queuedInputs: [
            { entityOrder: 1, input: input(3, 103, 0.1) },
            { entityOrder: 2, input: input(3, 203, -0.1) },
        ],
    }

    const restored = new PredictionWorld({ RAPIER, mapData })
    restored.restoreFullSync(sync)

    assert.equal(restored.tick, source.tick)
    assert.equal(restored.eventCursor, 7)
    assert.deepEqual(restored.readState().map(normalizedState), expected)
    assert.deepEqual(
        restored.queuedInputs.map((record) => [ record.entityOrder, record.input.sequence ]),
        [ [ 1, 103 ], [ 2, 203 ] ],
    )

    source.destroy()
    restored.destroy()
})

test('vehicle visuals mirror local state, create render-only remotes, and never mutate prediction state', () =>
{
    const sharedStates = [
        {
            entityOrder: 1,
            position: [ 1, 2, 3 ],
            quaternion: [ 0, 0, 0, 1 ],
            linearVelocity: [ 4, 0, 0 ],
            angularVelocity: [ 0, 1, 0 ],
            steering: 0.2,
            suspensions: 0,
            wheelContacts: [],
        },
        {
            entityOrder: 2,
            position: [ 5, 6, 7 ],
            quaternion: [ 0, 0, 0, 1 ],
            linearVelocity: [ 2, 0, 0 ],
            angularVelocity: [ 0, 0, 0 ],
            steering: -0.2,
            suspensions: 0,
            wheelContacts: [],
        },
    ]
    const original = structuredClone(sharedStates)
    const predictionWorld = { readState: () => sharedStates }
    const local = {
        modes: [],
        states: [],
        setExternalSimulation(active)
        {
            this.modes.push(active)
        },
        applyExternalState(state)
        {
            this.states.push(state)
            state.position[0] = 999
        },
    }
    const remoteInstances = []
    class FakeRemoteVehicle
    {
        constructor(game, entityOrder, template, options)
        {
            void game
            void template
            assert.deepEqual(options, { mode: 'authoritative' })
            this.entityOrder = entityOrder
            this.destroyed = false
            remoteInstances.push(this)
        }

        applyAuthoritativeState(state)
        {
            this.state = state
            state.position[0] = 888
        }

        update()
        {
            this.updated = true
        }

        destroy()
        {
            this.destroyed = true
        }
    }

    const visuals = new VehicleVisuals({
        game: {},
        predictionWorld,
        localEntityOrder: 1,
        physicalVehicle: local,
        vehicleTemplate: {},
        RemoteVehicleClass: FakeRemoteVehicle,
    })

    assert.deepEqual(local.modes, [ true ])
    assert.equal(visuals.update(), 2)
    assert.equal(local.states.length, 1)
    assert.equal(remoteInstances.length, 1)
    assert.equal(remoteInstances[0].entityOrder, 2)
    assert.equal(remoteInstances[0].updated, true)
    assert.deepEqual(sharedStates, original)

    sharedStates.splice(1)
    visuals.update()
    assert.equal(remoteInstances[0].destroyed, true)

    visuals.destroy()
    assert.deepEqual(local.modes, [ true, false ])
})

test('external local physics and authoritative remote rendering remain isolated from single-player', async () =>
{
    const physicsSource = await readSource('../sources/Game/Physics/PhysicsVehicle.js')
    const remoteSource = await readSource('../sources/Game/Multiplayer/RemoteVehicle.js')
    const entrySource = await readSource('../sources/index.js')

    assert.match(physicsSource, /this\.externalSimulation\s*=\s*false/)
    assert.match(physicsSource, /setExternalSimulation\(active\)/)
    assert.match(physicsSource, /applyExternalState\(state\)/)
    assert.match(physicsSource, /updatePrePhysics\(\)[\s\S]*if\(this\.externalSimulation\)\s*return/)
    assert.match(physicsSource, /updatePostPhysics\(\)[\s\S]*if\(this\.externalSimulation\)\s*return/)
    assert.match(physicsSource, /body\.setEnabled\(!this\.externalSimulation\)/)

    assert.match(remoteSource, /mode\s*=\s*['"]snapshot['"]/)
    assert.match(remoteSource, /applyAuthoritativeState\(state\)/)
    assert.match(remoteSource, /mode\s*===\s*['"]snapshot['"]\s*\?\s*new SnapshotBuffer\(\)\s*:\s*null/)
    assert.doesNotMatch(remoteSource, /RAPIER|PhysicsVehicle|createRigidBody|createCollider/)

    assert.doesNotMatch(entrySource, /MultiplayerV2/)
})
