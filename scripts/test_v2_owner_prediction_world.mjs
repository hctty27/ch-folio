import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    ROOM_EVENT_TYPES,
    ROOM_SLOT_STATES,
} from '@ch-folio/authoritative-physics'
import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'

const RAPIER = await loadRapierForNode()
const mapData = JSON.parse(await readFile(
    new URL('../packages/authoritative-physics/generated/map-v1.json', import.meta.url),
    'utf8',
))

function createTwoVehicleSync()
{
    const source = new PredictionWorld({ RAPIER, mapData })
    source.add(1, mapData.spawns[0])
    source.add(2, mapData.spawns[1])
    source.step()
    const sync = source.captureFullSync()
    source.destroy()
    return sync
}

function authoritativeStateFrom(state, overrides = {})
{
    return {
        entityOrder: state.entityOrder,
        stateFlags: ROOM_SLOT_STATES.ACTIVE,
        collisionFlags: 0,
        suspensions: state.suspensions,
        lastConfirmedSequence: state.lastConfirmedSequence,
        position: [ ...state.position ],
        quaternion: [ ...state.quaternion ],
        linearVelocity: [ ...state.linearVelocity ],
        angularVelocity: [ ...state.angularVelocity ],
        steering: 0,
        wheelRotations: [ 0, 0, 0, 0 ],
        controlFlags: 0,
        throttle: state.throttle,
        brake: state.brake,
        inputFlags: state.inputFlags,
        ...overrides,
    }
}

test('full sync retains only the configured local owner in prediction world', () =>
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.restoreFullSync(createTwoVehicleSync())
    prediction.setLocalEntityOrder(1)
    prediction.retainLocalEntity()

    assert.deepEqual(
        prediction.readState().map((state) => state.entityOrder),
        [ 1 ],
    )
    assert.deepEqual([ ...prediction.world.vehicles.keys() ], [ 1 ])
    prediction.destroy()
})

test('remote spawn events cannot recreate dynamic remote bodies after owner isolation', () =>
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.restoreFullSync(createTwoVehicleSync())
    prediction.setLocalEntityOrder(1)
    prediction.retainLocalEntity()

    prediction.step({ events: [ {
        tick: (prediction.tick + 1) >>> 0,
        type: ROOM_EVENT_TYPES.SPAWN,
        entityOrder: 2,
        spawnIndex: 1,
        flags: 1,
        value: 2,
    } ] })

    assert.deepEqual(
        prediction.readState().map((state) => state.entityOrder),
        [ 1 ],
    )
    prediction.destroy()
})

test('local authoritative restore rejects remote state and updates only the owner', () =>
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.restoreFullSync(createTwoVehicleSync())
    prediction.setLocalEntityOrder(1)
    prediction.retainLocalEntity()

    const before = prediction.readState(1)
    const remote = authoritativeStateFrom(before, { entityOrder: 2 })
    assert.throws(
        () => prediction.applyLocalAuthoritativeState(remote, 120),
        /local entity/i,
    )
    assert.deepEqual(prediction.readState(1).position, before.position)

    const position = [ before.position[0] + 0.5, before.position[1], before.position[2] ]
    const local = authoritativeStateFrom(before, {
        position,
        lastConfirmedSequence: 17,
    })
    prediction.applyLocalAuthoritativeState(local, 120)

    assert.equal(prediction.tick, 120)
    assert.deepEqual(prediction.readState().map((state) => state.entityOrder), [ 1 ])
    assert.deepEqual(prediction.readState(1).position, position.map(Math.fround))
    assert.equal(prediction.readState(1).lastConfirmedSequence, 17)
    prediction.destroy()
})
