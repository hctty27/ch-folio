import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ROOM_EVENT_TYPES,
    ROOM_SLOT_STATES,
    RoomSimulation,
    encodeFullSyncFrame,
    encodeStateFrame,
    findSafeSpawn,
} from '../src/index.js'

const MAP = Object.freeze({
    mapCollisionVersion: 1,
    colliders: [ {
        id: 'floor',
        shape: 'cuboid',
        center: [ 0, -2, 0 ],
        halfExtents: [ 100, 1, 100 ],
        quaternion: [ 0, 0, 0, 1 ],
        friction: 1,
        restitution: 0,
    } ],
    spawns: Array.from({ length: 8 }, (_, index) => ({
        index,
        source: `spawn/${String(index).padStart(2, '0')}`,
        position: [ index * 10, 0, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
        safetyHalfExtents: [ 2, 1.5, 1.4 ],
        approachHorizonSeconds: 0.5,
    })),
})

const FAKE_RAPIER = Object.freeze({
    Cuboid: class Cuboid
    {
        constructor(x, y, z)
        {
            this.halfExtents = [ x, y, z ]
        }
    },
    QueryFilterFlags: Object.freeze({ EXCLUDE_FIXED: 4 }),
})

function clone(value)
{
    return structuredClone(value)
}

class FakeWorld
{
    constructor()
    {
        this.tick = 0
        this.mapData = MAP
        this.RAPIER = FAKE_RAPIER
        this.world = {}
        this.vehicles = new Map()
        this.inputApplications = []
    }

    addVehicle(entityOrder, state)
    {
        this.vehicles.set(entityOrder, {
            entityOrder,
            position: [ ...state.position ],
            quaternion: [ ...state.quaternion ],
            linearVelocity: [ 0, 0, 0 ],
            angularVelocity: [ 0, 0, 0 ],
            steering: 0,
            confirmedInputSequence: 0,
        })
        return this.readVehicleState(entityOrder)
    }

    removeVehicle(entityOrder)
    {
        return this.vehicles.delete(entityOrder)
    }

    setInput(entityOrder, input)
    {
        const vehicle = this.vehicles.get(entityOrder)
        if(!vehicle)
            throw new Error(`unknown entityOrder ${entityOrder}`)

        vehicle.confirmedInputSequence = input.sequence >>> 0
        this.inputApplications.push({
            serverTick: this.tick + 1,
            entityOrder,
            input: clone(input),
        })
    }

    step()
    {
        this.tick++
        return this.tick
    }

    readVehicleState(entityOrder)
    {
        const vehicle = this.vehicles.get(entityOrder)
        if(!vehicle)
            throw new Error(`unknown entityOrder ${entityOrder}`)
        return clone(vehicle)
    }

    takeSnapshot()
    {
        return Uint8Array.from([ this.tick & 0xff, this.vehicles.size ])
    }
}

function input(clientTick, sequence = clientTick)
{
    return {
        clientTick,
        sequence,
        throttle: 255,
        brake: 0,
        steering: 1234,
        suspensions: 0x24,
        flags: 1,
    }
}

function createSimulation({ findSpawn } = {})
{
    const world = new FakeWorld()
    const simulation = new RoomSimulation({
        world,
        mapData: MAP,
        findSpawn,
    })
    return { simulation, world }
}

test('safe spawn scanning rejects exact overlap and half-second swept approaches in index order', () =>
{
    const queried = []
    const queryWorld = {
        intersectionsWithShape(position, rotation, shape, callback, flags)
        {
            queried.push({ position: position.x, rotation, shape, flags })
            if(position.x === 0 || position.x === 10)
                callback({ handle: position.x })
        },
    }

    const spawn = findSafeSpawn({
        RAPIER: FAKE_RAPIER,
        world: queryWorld,
        spawns: MAP.spawns,
        vehicleStates: [ {
            position: [ 14, 0, 0 ],
            linearVelocity: [ 8, 0, 0 ],
        } ],
    })

    assert.equal(spawn.index, 3)
    assert.deepEqual(queried.map((entry) => entry.position), [ 0, 10, 20, 30 ])
    assert.ok(queried.every((entry) => entry.flags === FAKE_RAPIER.QueryFilterFlags.EXCLUDE_FIXED))
    assert.ok(queried.every((entry) => entry.shape instanceof FAKE_RAPIER.Cuboid))
})

test('RoomSimulation rejects a ninth slot and reuses the lowest slot only after scheduled despawn', () =>
{
    const { simulation, world } = createSimulation({ findSpawn: () => null })
    const reserved = Array.from({ length: 8 }, (_, index) =>
        simulation.reserveSlot({ playerId: 100 + index }))

    assert.deepEqual(reserved.map((slot) => slot.entityOrder), [ 1, 2, 3, 4, 5, 6, 7, 8 ])
    assert.equal(simulation.reserveSlot({ playerId: 999 }), null)
    assert.equal(world.vehicles.size, 0)

    assert.equal(simulation.release(1), true)
    assert.equal(simulation.reserveSlot({ playerId: 999 }), null)

    simulation.advanceOneTick()
    const reused = simulation.reserveSlot({ playerId: 999 })
    assert.equal(reused.entityOrder, 1)

    const despawn = simulation.readStateFrame(0).events
        .find((event) => event.type === ROOM_EVENT_TYPES.DESPAWN)
    assert.equal(despawn.entityOrder, 1)
    assert.equal(despawn.tick, 1)
})

test('sync-ready players wait indefinitely and scan spawns 0 through 7 every three ticks', () =>
{
    let safeIndex = null
    const { simulation, world } = createSimulation({
        findSpawn: ({ spawns }) => safeIndex === null ? null : spawns[safeIndex],
    })

    assert.equal(simulation.reserveSlot({ playerId: 1 }).slotState, ROOM_SLOT_STATES.SYNCING)
    assert.equal(simulation.markSyncReady(1).slotState, ROOM_SLOT_STATES.WAITING_SPAWN)

    for(let tick = 0; tick < 6; tick++)
        simulation.advanceOneTick()

    assert.equal(world.vehicles.size, 0)
    assert.equal(simulation.createFullSync().entities[0].slotState, ROOM_SLOT_STATES.WAITING_SPAWN)

    safeIndex = 5
    for(let tick = 0; tick < 3; tick++)
        simulation.advanceOneTick()

    assert.equal(world.vehicles.has(1), true)
    assert.equal(simulation.createFullSync().entities[0].spawnIndex, 5)

    const spawn = simulation.readStateFrame(0).events
        .find((event) => event.type === ROOM_EVENT_TYPES.SPAWN)
    assert.equal(spawn.tick, 9)
    assert.equal(spawn.spawnIndex, 5)
})

test('RoomSimulation consumes target inputs exactly three server ticks later and counts late input', () =>
{
    const { simulation, world } = createSimulation({
        findSpawn: ({ spawns }) => spawns[0],
    })

    simulation.reserveSlot({ playerId: 1 })
    simulation.markSyncReady(1)
    for(let tick = 0; tick < 3; tick++)
        simulation.advanceOneTick()

    assert.equal(simulation.queueInput(1, input(4, 44)), true)
    for(let tick = 0; tick < 3; tick++)
        simulation.advanceOneTick()

    assert.equal(world.inputApplications.some((entry) => entry.input.sequence === 44), false)
    simulation.advanceOneTick()

    const applied = world.inputApplications.find((entry) => entry.input.sequence === 44)
    assert.equal(applied.serverTick, 7)
    assert.equal(simulation.queueInput(1, input(4, 45)), false)
    assert.equal(simulation.lateInputCount, 1)
})

test('disconnect keeps the physical vehicle for 180 ticks, resume cancels expiry, and expiry despawns deterministically', () =>
{
    const { simulation, world } = createSimulation({
        findSpawn: ({ spawns }) => spawns[0],
    })

    simulation.reserveSlot({ playerId: 1 })
    simulation.markSyncReady(1)
    for(let tick = 0; tick < 3; tick++)
        simulation.advanceOneTick()

    simulation.queueInput(1, input(4, 4))
    for(let tick = 0; tick < 4; tick++)
        simulation.advanceOneTick()

    assert.equal(simulation.disconnect(1), true)
    for(let tick = 0; tick < 12; tick++)
        simulation.advanceOneTick()

    const safeFallback = world.inputApplications.at(-1).input
    assert.equal(safeFallback.throttle, 128)
    assert.equal(safeFallback.brake, 255)
    assert.equal(safeFallback.steering, 0)

    for(let tick = 0; tick < 167; tick++)
        simulation.advanceOneTick()

    assert.equal(simulation.currentTick, 186)
    assert.equal(world.vehicles.has(1), true)
    assert.equal(simulation.resume(1), true)
    simulation.advanceOneTick()
    assert.equal(world.vehicles.has(1), true)

    assert.equal(simulation.disconnect(1), true)
    for(let tick = 0; tick < 179; tick++)
        simulation.advanceOneTick()
    assert.equal(world.vehicles.has(1), true)

    simulation.advanceOneTick()
    assert.equal(simulation.currentTick, 367)
    assert.equal(world.vehicles.has(1), false)
    assert.equal(simulation.reserveSlot({ playerId: 2 }).entityOrder, 1)

    const events = simulation.readStateFrame(0).events
    assert.ok(events.some((event) => event.type === ROOM_EVENT_TYPES.RESUME && event.tick === 186))
    assert.ok(events.some((event) => event.type === ROOM_EVENT_TYPES.DESPAWN && event.tick === 367))
})

test('state and full-sync payloads preserve entity orders one through eight', () =>
{
    const { simulation } = createSimulation({
        findSpawn: ({ spawns, entityOrder }) => spawns[entityOrder - 1],
    })

    for(let entityOrder = 1; entityOrder <= 8; entityOrder++)
    {
        simulation.reserveSlot({ playerId: entityOrder })
        simulation.markSyncReady(entityOrder)
    }

    for(let tick = 0; tick < 3; tick++)
        simulation.advanceOneTick()

    const stateFrame = simulation.readStateFrame(0)
    assert.deepEqual(stateFrame.states.map((state) => state.entityOrder), [ 1, 2, 3, 4, 5, 6, 7, 8 ])
    assert.doesNotThrow(() => encodeStateFrame(stateFrame))

    const fullSync = simulation.createFullSync()
    assert.deepEqual(fullSync.entities.map((entity) => entity.entityOrder), [ 1, 2, 3, 4, 5, 6, 7, 8 ])
    assert.doesNotThrow(() => encodeFullSyncFrame(fullSync))
})
