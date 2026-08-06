import mapSource from '../../../packages/authoritative-physics/generated/map-v1.json' with { type: 'json' }
import {
    AuthoritativeWorld,
    NO_SPAWN_INDEX,
    ROOM_EVENT_TYPES,
    ROOM_SLOT_STATES,
    VEHICLE_CONFIG,
    checksum32,
    dequantizeInput,
    loadAuthoritativeMap,
    readCanonicalState,
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

function sameEvent(left, right)
{
    return left.tick === right.tick
        && left.type === right.type
        && left.entityOrder === right.entityOrder
        && left.spawnIndex === right.spawnIndex
        && left.flags === right.flags
        && left.value === right.value
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

function copyWheelRotations(value)
{
    if(!Array.isArray(value) || value.length !== 4)
        return [ 0, 0, 0, 0 ]
    return value.map((rotation) => Number(rotation))
}

function copyMetadata(value = {})
{
    return {
        stateFlags: Number(value.stateFlags ?? value.slotState ?? ROOM_SLOT_STATES.ACTIVE),
        collisionFlags: Number(value.collisionFlags ?? 0),
        wheelRotations: copyWheelRotations(value.wheelRotations),
        controlFlags: Number(value.controlFlags ?? 0),
        spawnIndex: Number(value.spawnIndex ?? NO_SPAWN_INDEX),
        playerId: Number(value.playerId ?? 0) >>> 0,
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
        this.stateMetadata = new Map()
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
        this.stateMetadata.set(order, copyMetadata(state))
        return this.decorateState(added)
    }

    remove(entityOrderValue)
    {
        this.assertActive()
        const order = entityOrder(entityOrderValue)
        this.lastInputs.delete(order)
        this.stateMetadata.delete(order)
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
            if(!scheduled.some((existing) => sameEvent(existing, event)))
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
            {
                this.add(event.entityOrder, {
                    ...normalizeSpawn(this.mapData, event.spawnIndex),
                    spawnIndex: event.spawnIndex,
                })
            }
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
            if(!this.world.vehicles.has(record.entityOrder))
                continue
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

    canonicalStates()
    {
        this.assertActive()
        const states = [ ...this.world.vehicles.keys() ]
            .sort((left, right) => left - right)
            .map((order) =>
            {
                const state = this.world.readVehicleState(order)
                const input = this.lastInputs.get(order) ?? copyInput(this.world.getVehicle(order).input)
                const metadata = this.stateMetadata.get(order) ?? copyMetadata()
                return {
                    entityOrder: order,
                    stateFlags: metadata.stateFlags,
                    collisionFlags: metadata.collisionFlags,
                    suspensions: input.suspensions,
                    lastConfirmedSequence: state.confirmedInputSequence >>> 0,
                    position: state.position,
                    quaternion: state.quaternion,
                    linearVelocity: state.linearVelocity,
                    angularVelocity: state.angularVelocity,
                    steering: input.steering,
                    wheelRotations: metadata.wheelRotations,
                    controlFlags: metadata.controlFlags,
                    throttle: input.throttle,
                    brake: input.brake,
                    inputFlags: input.flags,
                }
            })
        return readCanonicalState(states)
    }

    checksum()
    {
        return checksum32(this.canonicalStates())
    }

    createCheckpoint()
    {
        this.assertActive()
        const states = this.readState()
        return {
            tick: this.tick,
            snapshot: this.world.takeSnapshot(),
            entities: states.map((state) =>
            {
                const metadata = this.stateMetadata.get(state.entityOrder) ?? copyMetadata()
                return {
                    entityOrder: state.entityOrder,
                    slotState: metadata.stateFlags,
                    spawnIndex: metadata.spawnIndex,
                    flags: HAS_BODY_FLAG,
                    playerId: metadata.playerId,
                    lastConfirmedSequence: state.lastConfirmedSequence,
                    controllerOffset: 0,
                    controllerLength: 0,
                }
            }),
            controllerMetadata: new Uint8Array(),
            confirmedSequences: states.map((state) => ({
                entityOrder: state.entityOrder,
                sequence: state.lastConfirmedSequence,
            })),
            eventCursor: this.eventCursor,
        }
    }

    captureFullSync()
    {
        const checkpoint = this.createCheckpoint()
        return {
            checkpointTick: checkpoint.tick,
            serverTick: checkpoint.tick,
            eventCursor: checkpoint.eventCursor,
            checksum32: this.checksum(),
            snapshot: checkpoint.snapshot,
            entities: checkpoint.entities,
            controllerMetadata: checkpoint.controllerMetadata,
            queuedInputs: this.queuedInputs.map(copyQueuedInput).sort(compareInputs),
        }
    }

    applyStateFrame(frame)
    {
        this.assertActive()
        if(!Array.isArray(frame?.states) || !Array.isArray(frame?.events))
            throw new TypeError('state frame must contain states and events arrays')

        const serverTick = uint32(frame.serverTick, 'serverTick')
        const states = readCanonicalState(frame.states)
        const targetOrders = new Set(states.map((state) => state.entityOrder))

        for(const order of [ ...this.world.vehicles.keys() ])
        {
            if(!targetOrders.has(order))
                this.remove(order)
        }

        for(const state of states)
        {
            const metadata = copyMetadata(state)
            if(!this.world.vehicles.has(state.entityOrder))
            {
                this.add(state.entityOrder, {
                    position: state.position,
                    quaternion: state.quaternion,
                    ...metadata,
                })
            }

            const input = {
                clientTick: serverTick,
                sequence: state.lastConfirmedSequence,
                throttle: state.throttle,
                brake: state.brake,
                steering: state.steering,
                suspensions: state.suspensions,
                flags: state.inputFlags,
            }
            const dequantized = dequantizeInput(input)
            this.world.setVehicleState(state.entityOrder, {
                position: state.position,
                quaternion: state.quaternion,
                linearVelocity: state.linearVelocity,
                angularVelocity: state.angularVelocity,
                steering: dequantized.steering * VEHICLE_CONFIG.steeringAmplitude,
                confirmedInputSequence: state.lastConfirmedSequence,
            })
            this.world.setInput(state.entityOrder, input)
            this.lastInputs.set(state.entityOrder, copyInput(input))
            this.stateMetadata.set(state.entityOrder, metadata)
        }

        this.world.tick = serverTick
        this.eventCursor = Number(frame.eventCursor ?? this.eventCursor) >>> 0
        this.eventsByTick.clear()
        this.queueEvents(frame.events)
        this.queuedInputs = []
        return this.checksum()
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
        const previousInputs = this.lastInputs
        const previousMetadata = this.stateMetadata
        const previousEvents = this.eventsByTick
        const previousQueuedInputs = this.queuedInputs
        const previousEventCursor = this.eventCursor

        this.world = replacement
        this.lastInputs = new Map()
        this.stateMetadata = new Map()
        this.eventsByTick = new Map()

        try
        {
            const entities = [ ...sync.entities ]
                .sort((left, right) => left.entityOrder - right.entityOrder)

            for(const descriptor of entities)
            {
                const order = entityOrder(descriptor.entityOrder)
                if((Number(descriptor.flags) & HAS_BODY_FLAG) === 0)
                    continue

                this.add(order, {
                    ...normalizeSpawn(this.mapData, descriptor.spawnIndex),
                    ...copyMetadata(descriptor),
                })
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
                this.stateMetadata.set(order, copyMetadata(descriptor))
            }

            this.queuedInputs = sync.queuedInputs.map(copyQueuedInput).sort(compareInputs)
            this.eventCursor = Number(sync.eventCursor ?? 0) >>> 0
        }
        catch(error)
        {
            this.world.destroy()
            this.world = previous
            this.lastInputs = previousInputs
            this.stateMetadata = previousMetadata
            this.eventsByTick = previousEvents
            this.queuedInputs = previousQueuedInputs
            this.eventCursor = previousEventCursor
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
        this.stateMetadata.clear()
        this.queuedInputs.length = 0
        this.world.destroy()
    }
}
