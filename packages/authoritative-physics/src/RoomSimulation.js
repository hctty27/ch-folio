import { checksum32, readCanonicalState } from './canonicalState.js'
import { quantizeInput, resolveMissingInput } from './input.js'
import { loadAuthoritativeMap } from './map.js'
import { encodeVehicleRuntimeMetadata } from './runtimeMetadata.js'
import { findSafeSpawn } from './spawnPoints.js'

const MAX_SLOTS = 8
const INPUT_BUFFER_TICKS = 3
const GRACE_TICKS = 180
const SPAWN_CHECK_INTERVAL_TICKS = 3
const NO_SPAWN_INDEX = 0xff

export const ROOM_SLOT_STATES = Object.freeze({
    SYNCING: 1,
    WAITING_SPAWN: 2,
    ACTIVE: 3,
    GRACE: 4,
})

export const ROOM_EVENT_TYPES = Object.freeze({
    SPAWN: 1,
    DESPAWN: 2,
    RESUME: 3,
    FULL_SYNC_REQUESTED: 4,
})

const EVENT_NAMES = Object.freeze({
    [ROOM_EVENT_TYPES.SPAWN]: 'spawn',
    [ROOM_EVENT_TYPES.DESPAWN]: 'despawn',
    [ROOM_EVENT_TYPES.RESUME]: 'resume',
    [ROOM_EVENT_TYPES.FULL_SYNC_REQUESTED]: 'fullSyncRequested',
})

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)

    return value
}

function uint8(value, label)
{
    return integer(value, 0, 0xff, label)
}

function uint32(value, label)
{
    return integer(value, 0, 0xffffffff, label)
}

function int16(value, label)
{
    return integer(value, -0x8000, 0x7fff, label)
}

function entityOrder(value)
{
    return integer(value, 1, MAX_SLOTS, 'entityOrder')
}

function suspensionBits(value, label)
{
    const packed = uint8(value, label)

    for(let wheelIndex = 0; wheelIndex < 4; wheelIndex++)
    {
        if(((packed >>> (wheelIndex * 2)) & 0b11) === 0b11)
            throw new TypeError(`${label} contains an invalid wheel state`)
    }

    return packed
}

function cloneInput(input)
{
    return {
        clientTick: uint32(input?.clientTick, 'input.clientTick'),
        sequence: uint32(input?.sequence, 'input.sequence'),
        throttle: uint8(input?.throttle, 'input.throttle'),
        brake: uint8(input?.brake, 'input.brake'),
        steering: int16(input?.steering, 'input.steering'),
        suspensions: suspensionBits(input?.suspensions, 'input.suspensions'),
        flags: uint8(input?.flags, 'input.flags'),
    }
}

function createSafeInput(clientTick = 0)
{
    return quantizeInput({
        clientTick,
        sequence: 0,
        throttle: 0,
        brake: 1,
        steering: 0,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    })
}

function slotFlags(slot)
{
    return (slot.hasBody ? 1 : 0)
        | (slot.slotState === ROOM_SLOT_STATES.GRACE ? 2 : 0)
        | (slot.releaseTick !== null ? 4 : 0)
}

function cloneSlot(slot)
{
    return {
        slot: slot.slot,
        entityOrder: slot.entityOrder,
        playerId: slot.playerId,
        slotState: slot.slotState,
        spawnIndex: slot.spawnIndex,
        flags: slotFlags(slot),
    }
}

function compareQueuedInputs(left, right)
{
    if(left.input.clientTick !== right.input.clientTick)
        return left.input.clientTick - right.input.clientTick

    if(left.entityOrder !== right.entityOrder)
        return left.entityOrder - right.entityOrder

    return left.input.sequence - right.input.sequence
}

function concatenate(chunks)
{
    const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const result = new Uint8Array(byteLength)
    let offset = 0
    for(const chunk of chunks)
    {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result
}

function assertWorld(world)
{
    const methods = [
        'addVehicle',
        'removeVehicle',
        'setInput',
        'step',
        'readVehicleState',
        'takeSnapshot',
    ]

    if(!world || methods.some((method) => typeof world[method] !== 'function'))
        throw new TypeError('RoomSimulation requires an AuthoritativeWorld-compatible world')
}

export class RoomSimulation
{
    constructor({
        world,
        mapData = world?.mapData,
        findSpawn = findSafeSpawn,
    })
    {
        assertWorld(world)
        if(typeof findSpawn !== 'function')
            throw new TypeError('findSpawn must be a function')

        this.world = world
        this.mapData = loadAuthoritativeMap(mapData)
        this.findSpawn = findSpawn
        this.currentTick = Number(world.tick) >>> 0
        this.slots = Array(MAX_SLOTS).fill(null)
        this.events = []
        this.eventCursor = 0
        this.lateInputCount = 0
    }

    getSlot(entityOrderValue)
    {
        const order = entityOrder(entityOrderValue)
        const slot = this.slots[order - 1]
        if(!slot)
            throw new Error(`unknown entityOrder ${order}`)
        return slot
    }

    emitEvent(type, slot, tick, spawnIndex = slot.spawnIndex)
    {
        const event = Object.freeze({
            cursor: ++this.eventCursor,
            type,
            eventName: EVENT_NAMES[type],
            entityOrder: slot.entityOrder,
            spawnIndex,
            flags: slotFlags(slot),
            tick: tick >>> 0,
            value: slot.playerId,
        })
        this.events.push(event)
        return event
    }

    reserveSlot(descriptor)
    {
        const playerId = uint32(
            typeof descriptor === 'object' ? descriptor?.playerId : descriptor,
            'playerId',
        )

        if(this.slots.some((slot) => slot?.playerId === playerId))
            throw new Error(`duplicate playerId ${playerId}`)

        const slotIndex = this.slots.findIndex((slot) => slot === null)
        if(slotIndex === -1)
            return null

        const slot = {
            slot: slotIndex,
            entityOrder: slotIndex + 1,
            playerId,
            slotState: ROOM_SLOT_STATES.SYNCING,
            resumeSlotState: null,
            spawnIndex: NO_SPAWN_INDEX,
            hasBody: false,
            queuedInputs: new Map(),
            lastInput: createSafeInput(0),
            lastConsumedInputTick: null,
            lastConfirmedSequence: 0,
            disconnectTick: null,
            graceExpiresTick: null,
            releaseTick: null,
        }

        this.slots[slotIndex] = slot
        this.emitEvent(ROOM_EVENT_TYPES.FULL_SYNC_REQUESTED, slot, this.currentTick)
        return cloneSlot(slot)
    }

    markSyncReady(entityOrderValue)
    {
        const slot = this.getSlot(entityOrderValue)
        if(slot.slotState !== ROOM_SLOT_STATES.SYNCING)
            throw new Error(`entityOrder ${slot.entityOrder} is not syncing`)

        slot.slotState = ROOM_SLOT_STATES.WAITING_SPAWN
        return cloneSlot(slot)
    }

    queueInput(entityOrderValue, input)
    {
        const slot = this.getSlot(entityOrderValue)
        if(slot.slotState !== ROOM_SLOT_STATES.ACTIVE || slot.releaseTick !== null)
            return false

        const queued = cloneInput(input)
        if(slot.lastConsumedInputTick !== null && queued.clientTick <= slot.lastConsumedInputTick)
        {
            this.lateInputCount++
            return false
        }

        const existing = slot.queuedInputs.get(queued.clientTick)
        if(existing && existing.sequence >= queued.sequence)
            return false

        slot.queuedInputs.set(queued.clientTick, queued)
        return true
    }

    disconnect(entityOrderValue)
    {
        const slot = this.getSlot(entityOrderValue)
        if(slot.slotState === ROOM_SLOT_STATES.GRACE || slot.releaseTick !== null)
            return false

        slot.resumeSlotState = slot.slotState
        slot.slotState = ROOM_SLOT_STATES.GRACE
        slot.disconnectTick = this.currentTick
        slot.graceExpiresTick = (this.currentTick + GRACE_TICKS) >>> 0
        slot.queuedInputs.clear()
        return true
    }

    resume(entityOrderValue)
    {
        const slot = this.getSlot(entityOrderValue)
        if(slot.slotState !== ROOM_SLOT_STATES.GRACE || slot.releaseTick !== null)
            return false

        slot.slotState = slot.resumeSlotState
        slot.resumeSlotState = null
        slot.disconnectTick = null
        slot.graceExpiresTick = null
        this.emitEvent(ROOM_EVENT_TYPES.RESUME, slot, this.currentTick)
        this.emitEvent(ROOM_EVENT_TYPES.FULL_SYNC_REQUESTED, slot, this.currentTick)
        return true
    }

    release(entityOrderValue)
    {
        const slot = this.getSlot(entityOrderValue)
        if(slot.releaseTick !== null)
            return false

        slot.releaseTick = (this.currentTick + 1) >>> 0
        return true
    }

    despawnSlot(slot, tick)
    {
        const spawnIndex = slot.spawnIndex
        if(slot.hasBody)
            this.world.removeVehicle(slot.entityOrder)

        slot.hasBody = false
        this.emitEvent(ROOM_EVENT_TYPES.DESPAWN, slot, tick, spawnIndex)
        this.slots[slot.slot] = null
    }

    processScheduledDespawns(tick)
    {
        for(const slot of this.slots)
        {
            if(!slot)
                continue

            if(slot.releaseTick === tick || (
                slot.slotState === ROOM_SLOT_STATES.GRACE
                && slot.graceExpiresTick === tick
            ))
                this.despawnSlot(slot, tick)
        }
    }

    vehicleStates()
    {
        return this.slots
            .filter((slot) => slot?.hasBody)
            .sort((left, right) => left.entityOrder - right.entityOrder)
            .map((slot) => this.world.readVehicleState(slot.entityOrder))
    }

    attemptSpawns(tick)
    {
        const waiting = this.slots
            .filter((slot) => slot?.slotState === ROOM_SLOT_STATES.WAITING_SPAWN)
            .sort((left, right) => left.entityOrder - right.entityOrder)

        for(const slot of waiting)
        {
            const spawn = this.findSpawn({
                RAPIER: this.world.RAPIER,
                world: this.world.world,
                spawns: this.mapData.spawns,
                vehicleStates: this.vehicleStates(),
                entityOrder: slot.entityOrder,
            })

            if(spawn === null)
                continue

            this.world.addVehicle(slot.entityOrder, {
                position: spawn.position,
                quaternion: spawn.quaternion,
            })
            slot.hasBody = true
            slot.slotState = ROOM_SLOT_STATES.ACTIVE
            slot.spawnIndex = spawn.index
            slot.lastInput = createSafeInput(Math.max(0, tick - INPUT_BUFFER_TICKS))
            this.emitEvent(ROOM_EVENT_TYPES.SPAWN, slot, tick)
        }
    }

    consumeInputs(tick)
    {
        if(tick < INPUT_BUFFER_TICKS)
            return

        const inputTick = tick - INPUT_BUFFER_TICKS
        const active = this.slots
            .filter((slot) => slot?.hasBody)
            .sort((left, right) => left.entityOrder - right.entityOrder)

        for(const slot of active)
        {
            let applied = null
            if(slot.slotState === ROOM_SLOT_STATES.ACTIVE)
                applied = slot.queuedInputs.get(inputTick) ?? null

            if(applied === null)
                applied = resolveMissingInput(slot.lastInput, inputTick)

            this.world.setInput(slot.entityOrder, applied)
            slot.lastInput = cloneInput(applied)
            slot.lastConsumedInputTick = inputTick
            slot.lastConfirmedSequence = applied.sequence >>> 0

            for(const queuedTick of slot.queuedInputs.keys())
            {
                if(queuedTick <= inputTick)
                    slot.queuedInputs.delete(queuedTick)
            }
        }
    }

    advanceOneTick()
    {
        const tick = (this.currentTick + 1) >>> 0
        this.processScheduledDespawns(tick)

        if(tick % SPAWN_CHECK_INTERVAL_TICKS === 0)
            this.attemptSpawns(tick)

        this.consumeInputs(tick)
        this.world.step()
        this.currentTick = tick
        return tick
    }

    canonicalStates()
    {
        const states = this.slots
            .filter((slot) => slot?.hasBody)
            .sort((left, right) => left.entityOrder - right.entityOrder)
            .map((slot) =>
            {
                const state = this.world.readVehicleState(slot.entityOrder)
                return {
                    entityOrder: slot.entityOrder,
                    stateFlags: slot.slotState,
                    collisionFlags: 0,
                    suspensions: slot.lastInput.suspensions,
                    lastConfirmedSequence: state.confirmedInputSequence
                        ?? slot.lastConfirmedSequence,
                    position: state.position,
                    quaternion: state.quaternion,
                    linearVelocity: state.linearVelocity,
                    angularVelocity: state.angularVelocity,
                    steering: slot.lastInput.steering,
                    wheelRotations: [ 0, 0, 0, 0 ],
                    controlFlags: 0,
                    throttle: slot.lastInput.throttle,
                    brake: slot.lastInput.brake,
                    inputFlags: slot.lastInput.flags,
                }
            })

        return readCanonicalState(states)
    }

    readStateFrame(afterEventCursor = 0)
    {
        const cursor = uint32(afterEventCursor, 'afterEventCursor')
        const states = this.canonicalStates()

        return {
            serverTick: this.currentTick,
            eventCursor: this.eventCursor,
            checksum32: checksum32(states),
            states,
            events: this.events.filter((event) => event.cursor > cursor),
            worldHash: null,
        }
    }

    createFullSync()
    {
        const states = this.canonicalStates()
        const metadataChunks = []
        let metadataOffset = 0
        const entities = this.slots
            .filter(Boolean)
            .sort((left, right) => left.entityOrder - right.entityOrder)
            .map((slot) =>
            {
                let controllerOffset = metadataOffset
                let controllerLength = 0
                if(slot.hasBody && typeof this.world.readVehicleRuntime === 'function')
                {
                    const encoded = encodeVehicleRuntimeMetadata(
                        this.world.readVehicleRuntime(slot.entityOrder),
                    )
                    metadataChunks.push(encoded)
                    controllerLength = encoded.byteLength
                    metadataOffset += controllerLength
                }

                return {
                    entityOrder: slot.entityOrder,
                    slotState: slot.slotState,
                    spawnIndex: slot.spawnIndex,
                    flags: slotFlags(slot),
                    playerId: slot.playerId,
                    lastConfirmedSequence: slot.lastConfirmedSequence,
                    controllerOffset,
                    controllerLength,
                }
            })
        const queuedInputs = this.slots
            .filter(Boolean)
            .flatMap((slot) => [ ...slot.queuedInputs.values() ]
                .map((input) => ({
                    entityOrder: slot.entityOrder,
                    input: cloneInput(input),
                })))
            .sort(compareQueuedInputs)

        return {
            checkpointTick: this.currentTick,
            serverTick: this.currentTick,
            eventCursor: this.eventCursor,
            checksum32: checksum32(states),
            snapshot: Uint8Array.from(this.world.takeSnapshot()),
            entities,
            controllerMetadata: concatenate(metadataChunks),
            queuedInputs,
        }
    }
}

export {
    GRACE_TICKS,
    INPUT_BUFFER_TICKS,
    MAX_SLOTS,
    NO_SPAWN_INDEX,
    SPAWN_CHECK_INTERVAL_TICKS,
}
