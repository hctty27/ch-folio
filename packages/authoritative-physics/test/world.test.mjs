import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    AuthoritativeWorld,
    quantizeInput,
} from '../src/index.js'
import { loadRapierForNode } from './loadRapierForNode.mjs'

const RAPIER = await loadRapierForNode()
const mapData = JSON.parse(await readFile(
    new URL('../generated/map-v1.json', import.meta.url),
    'utf8',
))

function encodeStates(world, entityOrders)
{
    const bytes = new Uint8Array(entityOrders.length * 64)
    const view = new DataView(bytes.buffer)
    let offset = 0

    for(const entityOrder of entityOrders)
    {
        const state = world.readVehicleState(entityOrder)
        view.setUint32(offset, state.entityOrder, true)
        offset += 4

        for(const value of [
            ...state.position,
            ...state.quaternion,
            ...state.linearVelocity,
            ...state.angularVelocity,
            state.steering,
        ])
        {
            view.setFloat32(offset, Math.fround(value), true)
            offset += 4
        }

        view.setUint32(offset, state.confirmedInputSequence, true)
        offset += 4
    }

    return bytes
}

function createInput(tick, direction)
{
    return quantizeInput({
        clientTick: tick,
        sequence: tick,
        throttle: tick < 100 ? 1 : 0,
        brake: tick >= 110 ? 0.5 : 0,
        steering: direction * (((tick % 30) - 15) / 60),
        suspensions: [ 'low', 'mid', 'high', 'low' ],
        boosting: tick >= 30 && tick < 60,
        honking: false,
    })
}

function createWorldPair()
{
    const first = new AuthoritativeWorld({ RAPIER, mapData })
    const second = new AuthoritativeWorld({ RAPIER, mapData })

    for(const world of [ first, second ])
    {
        world.addVehicle(1, {
            position: [ -4, 2, 0 ],
            quaternion: [ 0, 0, 0, 1 ],
        })
        world.addVehicle(2, {
            position: [ 4, 2, 0 ],
            quaternion: [ 0, 1, 0, 0 ],
        })
    }

    return [ first, second ]
}

test('two authoritative worlds produce byte-identical states and Rapier snapshots', () =>
{
    const [ first, second ] = createWorldPair()

    try
    {
        for(let tick = 1; tick <= 120; tick++)
        {
            const firstInput = createInput(tick, 1)
            const secondInput = createInput(tick, -1)

            for(const world of [ first, second ])
            {
                world.setInput(1, firstInput)
                world.setInput(2, secondInput)
                world.step()
            }
        }

        const firstStates = encodeStates(first, [ 1, 2 ])
        const secondStates = encodeStates(second, [ 1, 2 ])
        assert.deepEqual(firstStates, secondStates)

        const firstSnapshot = first.takeSnapshot()
        const secondSnapshot = second.takeSnapshot()
        assert.ok(firstSnapshot.byteLength > 0)
        assert.deepEqual(firstSnapshot, secondSnapshot)

        const state = first.readVehicleState(1)
        assert.ok(state.position.every(Number.isFinite))
        assert.ok(state.linearVelocity.every(Number.isFinite))
        assert.equal(state.confirmedInputSequence, 120)
    }
    finally
    {
        first.destroy()
        second.destroy()
    }
})

test('snapshot restore, explicit state writes, removal, and destroy preserve the world contract', () =>
{
    const world = new AuthoritativeWorld({ RAPIER, mapData })
    world.addVehicle(1, {
        position: [ 0, 2, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
    })

    try
    {
        world.setInput(1, createInput(1, 1))
        world.step()

        const snapshot = world.takeSnapshot()
        const before = encodeStates(world, [ 1 ])

        for(let tick = 2; tick <= 20; tick++)
        {
            world.setInput(1, createInput(tick, 1))
            world.step()
        }

        world.restoreSnapshot(snapshot)
        assert.deepEqual(encodeStates(world, [ 1 ]), before)

        world.setVehicleState(1, {
            position: [ 5, 3, 2 ],
            quaternion: [ 0, 0, 0, 1 ],
            linearVelocity: [ 1, 2, 3 ],
            angularVelocity: [ 0.25, 0.5, 0.75 ],
            steering: 0.125,
            confirmedInputSequence: 77,
        })

        assert.deepEqual(world.readVehicleState(1), {
            entityOrder: 1,
            position: [ 5, 3, 2 ],
            quaternion: [ 0, 0, 0, 1 ],
            linearVelocity: [ 1, 2, 3 ],
            angularVelocity: [ 0.25, 0.5, 0.75 ],
            steering: 0.125,
            confirmedInputSequence: 77,
        })

        assert.equal(world.removeVehicle(1), true)
        assert.equal(world.removeVehicle(1), false)
        assert.throws(() => world.readVehicleState(1), /unknown entityOrder 1/)
    }
    finally
    {
        world.destroy()
        world.destroy()
    }
})
