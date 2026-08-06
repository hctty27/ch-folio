import mapSource from '../../../packages/authoritative-physics/generated/map-v1.json' with { type: 'json' }
import {
    AuthoritativeWorld,
    ROOM_EVENT_TYPES,
    VEHICLE_CONFIG,
    loadAuthoritativeMap,
} from '@ch-folio/authoritative-physics'

const HAS_BODY_FLAG = 1
const MAX_ENTITIES = 8

function entityOrder(value, label = 'entityOrder')
{
    if(!Number.isInteger(value) || value < 1 || value > MAX_ENTITIES)
        throw new TypeError(`${label} must be an integer from 1 to ${MAX_ENTITIES}`)
    return value
}

function uint32(value, label)
{
    if(!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new TypeError(`${label} must be an unsigned 32-bit integer`)
    return value >>> 0
}

function copyInput(input)
{
    return {
        clientTick: Number(input?.clientTick) >>> 0,
        sequence: Number(input?.sequence) >>> 0,
        throttle: Number(input?.throttle),
        brake: Number(input?.brake),
        steering: Number(input?.steering),
        suspensions: Number(input?.suspensions),
        flags: Number(input?.flags),
    }
}

function copyQueuedInput(record)
{
    return {
        entityOrder: entityOrder(record?.entityOrder),
        input: copyInput(record?.input),
    }
}

function compareInputs(left, right)
{
    if(left.input.clientTick !== right.input.clientTick)
        return left.input.clientTick - right.input.clientTick
    if(left.entityOrder !== right.entityOrder)
        return left.entityOrder - right.entityOrder
    return left.input.sequence - right.input.sequence
}

function copyEvent(event)
{
    return {
        tick: uint32(event?.tick, 'event.tick'),
        type: Number(event?.type),
        entityOrder: entityOrder(event?.entityOrder, 'event.entityOrder'),
        spawnIndex: Number(event?.spawnIndex),
        flags: Number(event?.flags ?? 0),
        value: Number(event?.value ?? 0),
    }
}

function compareEvents(left, right)
{
    if(left.tick !== right.tick)
        return left.tick - right.tick
    if(left.entityOrder !== right.entityOrder)
        return left.entityOrder - right.entityOrder
    return left.type - right.type
}

function vector(value)
{
    return value === null || value === undefined
        ? null
        : [ value.x, value.y, value.z ]
}

function forwardFromQuaternion(rotation)
{
    return [
        1 - 2 * (rotation[1] * rotation[1] + rotation[2] * rotation[2]),
        2 * (rotation[0] * rotation[1] + rotation[2] * rotation[3]),
        2 * (rotation[0] * rotation[2] - rotation[1] * rotation[3]),
    ]
}

function readWheelContacts(vehicle)
{
    return Array.from({ length: VEHICLE_CONFIG.wheelOrder.length }, (_, wheelIndex) =>
    {
        const controller = vehicle.controller
        const inContact = controller.wheelIsInContact(wheelIndex)
        return {
            inContact,
            contactPoint: inContact ? vector(controller.wheelContactPoint(wheelIndex)) : null,
            suspensionLength: controller.wheelSuspensionLength(wheelIndex),
        }
    })
}

function normalizeSpawn(mapData, spawnIndex)
{
    const index = Number(spawnIndex)
    if(Number.isInteger(index) && index >= 0 && index < mapData.spawns.length)
        return mapData.spawns[index]

    return {
        position: VEHICLE_CONFIG.spawnPosition,
        quaternion: [ 0, 0, 0, 1 ],
    }
}

export class PredictionWorld
{
    constructor({ RAPIER, mapData = mapSource } = {})
    {
        if(!RAPIER)
            throw new TypeError('PredictionWorld requires a Rapier module')

        this.RAPIER = RAPIER
        this.mapData = loadAuthoritativeMap(mapData)
        this.eventsByTick = new Map()
        this.lastInputs = new Map()
        this.queuedInputs = []
        this.eventCursor = 0
        this.destroyed = false
        this.world = this.createWorld()
    }

    get tick()
    {
        return this.world.tick >>> 0
    }

    createWorld()
    {
        return new AuthoritativeWorld({
            RAPIER: this.RAPIER,
            mapData: this.mapData,
        })
    }

    assertActive()
    {
        if(this.destroyed)
            throw new Error('PredictionWorld has been destroyed')
    }

    add(entityOrderValue, state = {})
    {
        this.assertActive()
        const order = entityOrder(entityOrderValue)
        const added = this.world.addVehicle(order, state)
        const vehicle = this.world.getVehicle(order)
        this.lastInputs.set(order, copyInput(vehicle.input))
        return this.decorateState(added)
    }

    remove(entityOrderValue)
    {
        this.assertActive()
        const order = entityOrder(entityOrderValue)
        this.lastInputs.delete(order)
        this.queuedInputs = this.queuedInputs.filter((record) => record.entityOrder !== order)
        return this.world.removeVehicle(order)
    }

    queueEvents(events)
    {
        if(!Array.isArray(events))
            throw new TypeError('events must be an array')

        for(const source of events)
        {
            const event = copyEvent(source)
            const scheduled = this.eventsByTick.get(event.tick) ?? []
            scheduled.push(event)
            scheduled.sort(compareEvents)
            this.eventsByTick.set(event.tick, scheduled)
        }
    }

    applyEvent(event)
    {
        if(event.type === ROOM_EVENT_TYPES.SPAWN)
        {
            if(!this.world.vehicles.has(event.entityOrder))
                this.add(event.entityOrder, normalizeSpawn(this.mapData, event.spawnIndex))
            return
        }

        if(event.type === ROOM_EVENT_TYPES.DESPAWN)
            this.remove(event.entityOrder)
    }

    applyInputs(records)
    {
        this.assertActive()
        if(!Array.isArray(records))
            throw new TypeError('inputs must be an array')

        const canonical = records.map(copyQueuedInput).sort(compareInputs)
        for(const record of canonical)
        {
            this.world.setInput(record.entityOrder, record.input)
            this.lastInputs.set(record.entityOrder, record.input)
        }
        return canonical.length
    }

    consumeQueuedInputs(targetTick)
    {
        const ready = []
        const future = []

        for(const record of this.queuedInputs)
        {
            if(record.input.clientTick <= targetTick && this.world.vehicles.has(record.entityOrder))
                ready.push(record)
            else
                future.push(record)
        }

        this.queuedInputs = future
        if(ready.length > 0)
            this.applyInputs(ready)
    }

    step({ events = [], inputs = [] } = {})
    {
        this.assertActive()
        this.queueEvents(events)

        const targetTick = (this.tick + 1) >>> 0
        const scheduled = this.eventsByTick.get(targetTick) ?? []
        for(const event of scheduled)
            this.applyEvent(event)
        this.eventsByTick.delete(targetTick)

        this.consumeQueuedInputs(targetTick)
        if(inputs.length > 0)
            this.applyInputs(inputs)

        return this.world.step()
    }

    decorateState(state)
    {
        const vehicle = this.world.getVehicle(state.entityOrder)
        const input = this.lastInputs.get(state.entityOrder) ?? copyInput(vehicle.input)
        const speed = Math.hypot(...state.linearVelocity)
        const forward = forwardFromQuaternion(state.quaternion)
        const forwardSpeed = (
            state.linearVelocity[0] * forward[0]
            + state.linearVelocity[1] * forward[1]
            + state.linearVelocity[2] * forward[2]
        )

        return {
            ...state,
            lastConfirmedSequence: state.confirmedInputSequence >>> 0,
            suspensions: input.suspensions,
            throttle: input.throttle,
            brake: input.brake,
            inputFlags: input.flags,
            speed,
            forwardSpeed,
            goingForward: forwardSpeed >= 0,
            wheelContacts: readWheelContacts(vehicle),
        }
    }

    readState(entityOrderValue = null)
    {
        this.assertActive()
        if(entityOrderValue !== null)
            return this.decorateState(this.world.readVehicleState(entityOrder(entityOrderValue)))

        return [ ...this.world.vehicles.keys() ]
            .sort((left, right) => left - right)
            .map((order) => this.decorateState(this.world.readVehicleState(order)))
    }

    restoreFullSync(sync)
    {
        this.assertActive()
        if(!(sync?.snapshot instanceof Uint8Array))
            throw new TypeError('full sync snapshot must be a Uint8Array')
        if(!Array.isArray(sync?.entities) || !Array.isArray(sync?.queuedInputs))
            throw new TypeError('full sync entities and queuedInputs must be arrays')

        const replacement = this.createWorld()
        const previous = this.world
        this.world = replacement
        this.lastInputs.clear()
        this.eventsByTick.clear()

        try
        {
            const entities = [ ...sync.entities ]
                .sort((left, right) => left.entityOrder - right.entityOrder)

            for(const descriptor of entities)
            {
                const order = entityOrder(descriptor.entityOrder)
                if((Number(descriptor.flags) & HAS_BODY_FLAG) === 0)
                    continue

                this.add(order, normalizeSpawn(this.mapData, descriptor.spawnIndex))
            }

            this.world.restoreSnapshot(Uint8Array.from(sync.snapshot))
            this.world.tick = uint32(sync.checkpointTick, 'checkpointTick')

            for(const descriptor of entities)
            {
                const order = entityOrder(descriptor.entityOrder)
                if(!this.world.vehicles.has(order))
                    continue

                const vehicle = this.world.getVehicle(order)
                const sequence = Number(descriptor.lastConfirmedSequence ?? 0) >>> 0
                vehicle.confirmedInputSequence = sequence
                vehicle.input.sequence = sequence
                this.lastInputs.set(order, copyInput(vehicle.input))
            }

            this.queuedInputs = sync.queuedInputs.map(copyQueuedInput).sort(compareInputs)
            this.eventCursor = Number(sync.eventCursor ?? 0) >>> 0
        }
        catch(error)
        {
            this.world.destroy()
            this.world = previous
            throw error
        }

        previous.destroy()
        return this.readState()
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.destroyed = true
        this.eventsByTick.clear()
        this.lastInputs.clear()
        this.queuedInputs.length = 0
        this.world.destroy()
    }
}
