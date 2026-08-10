import {
    NO_SPAWN_INDEX,
    ROOM_SLOT_STATES,
    VEHICLE_CONFIG,
    dequantizeInput,
} from '@ch-folio/authoritative-physics'
import { PredictionWorld as PredictionWorldBase } from './PredictionWorldBase.js'

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

function forwardFromQuaternion(rotation)
{
    return [
        1 - 2 * (rotation[1] * rotation[1] + rotation[2] * rotation[2]),
        2 * (rotation[0] * rotation[1] + rotation[2] * rotation[3]),
        2 * (rotation[0] * rotation[2] - rotation[1] * rotation[3]),
    ]
}

export class PredictionWorld extends PredictionWorldBase
{
    constructor(options = {})
    {
        super(options)
        this.localEntityOrder = null
    }

    setLocalEntityOrder(value)
    {
        this.assertActive()
        this.localEntityOrder = entityOrder(value, 'localEntityOrder')
        return this.localEntityOrder
    }

    retainLocalEntity()
    {
        this.assertActive()
        if(this.localEntityOrder === null)
            throw new Error('local entity order must be configured before owner isolation')

        for(const order of [ ...this.world.vehicles.keys() ])
        {
            if(order !== this.localEntityOrder)
                super.remove(order)
        }

        this.queuedInputs = this.queuedInputs.filter(
            (record) => record.entityOrder === this.localEntityOrder,
        )
        for(const [ tick, events ] of this.eventsByTick)
        {
            const localEvents = events.filter(
                (event) => event.entityOrder === this.localEntityOrder,
            )
            if(localEvents.length === 0)
                this.eventsByTick.delete(tick)
            else
                this.eventsByTick.set(tick, localEvents)
        }

        return this.readState()
    }

    queueEvents(events)
    {
        if(this.localEntityOrder === null || !Array.isArray(events))
            return super.queueEvents(events)

        return super.queueEvents(events.filter(
            (event) => event?.entityOrder === this.localEntityOrder,
        ))
    }

    applyEvent(event)
    {
        if(
            this.localEntityOrder !== null
            && event?.entityOrder !== this.localEntityOrder
        )
            return
        return super.applyEvent(event)
    }

    applyInputs(records)
    {
        if(this.localEntityOrder === null || !Array.isArray(records))
            return super.applyInputs(records)

        return super.applyInputs(records.filter(
            (record) => record?.entityOrder === this.localEntityOrder,
        ))
    }

    applyLocalAuthoritativeState(state, serverTick)
    {
        this.assertActive()
        if(this.localEntityOrder === null)
            throw new Error('local entity order must be configured before authoritative restore')
        if(entityOrder(state?.entityOrder, 'state.entityOrder') !== this.localEntityOrder)
            throw new Error('authoritative state does not belong to the local entity')

        const tick = uint32(serverTick, 'serverTick')
        if(!this.world.vehicles.has(this.localEntityOrder))
        {
            super.add(this.localEntityOrder, {
                position: state.position,
                quaternion: state.quaternion,
                ...copyMetadata(state),
            })
        }

        const runtime = this.world.readVehicleRuntime(this.localEntityOrder)
        const input = {
            ...runtime.input,
            clientTick: tick,
            sequence: Number(state.lastConfirmedSequence ?? runtime.confirmedInputSequence) >>> 0,
            throttle: Number(state.throttle ?? runtime.input.throttle),
            brake: Number(state.brake ?? runtime.input.brake),
            steering: Number(state.steering ?? runtime.input.steering),
            suspensions: Number(state.suspensions ?? runtime.input.suspensions),
            flags: Number(state.inputFlags ?? runtime.input.flags),
        }
        const dequantized = dequantizeInput(input)
        const forward = forwardFromQuaternion(state.quaternion)
        const speed = Math.hypot(...state.linearVelocity)
        const forwardVelocity = (
            state.linearVelocity[0] * forward[0]
            + state.linearVelocity[1] * forward[1]
            + state.linearVelocity[2] * forward[2]
        )

        this.world.setVehicleState(this.localEntityOrder, {
            position: state.position,
            quaternion: state.quaternion,
            linearVelocity: state.linearVelocity,
            angularVelocity: state.angularVelocity,
            steering: dequantized.steering * VEHICLE_CONFIG.steeringAmplitude,
            confirmedInputSequence: input.sequence,
            input,
            speed,
            goingForward: speed <= Number.EPSILON
                ? runtime.goingForward
                : forwardVelocity >= 0,
            previousPosition: state.position,
        })
        this.lastInputs.set(this.localEntityOrder, { ...input })
        this.stateMetadata.set(this.localEntityOrder, copyMetadata(state))
        this.world.tick = tick
        this.queuedInputs = this.queuedInputs.filter(
            (record) => record.entityOrder === this.localEntityOrder,
        )
        return this.readState(this.localEntityOrder)
    }

    applyStateFrame(frame)
    {
        if(this.localEntityOrder === null)
            return super.applyStateFrame(frame)
        this.assertActive()
        if(!Array.isArray(frame?.states) || !Array.isArray(frame?.events))
            throw new TypeError('state frame must contain states and events arrays')

        const serverTick = uint32(frame.serverTick, 'serverTick')
        const authoritativeLocal = frame.states.find(
            (state) => state.entityOrder === this.localEntityOrder,
        )

        if(authoritativeLocal)
            this.applyLocalAuthoritativeState(authoritativeLocal, serverTick)
        else
        {
            super.remove(this.localEntityOrder)
            this.world.tick = serverTick
        }

        this.eventCursor = Number(frame.eventCursor ?? this.eventCursor) >>> 0
        this.eventsByTick.clear()
        this.queueEvents(frame.events)
        this.queuedInputs = []
        return this.checksum()
    }

    restoreFullSync(sync)
    {
        const states = super.restoreFullSync(sync)
        if(this.localEntityOrder === null)
            return states
        return this.retainLocalEntity()
    }
}
