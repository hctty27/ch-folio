import { ROOM_EVENT_TYPES } from '@ch-folio/authoritative-physics'
import { RemoteVehicle } from '../Multiplayer/RemoteVehicle.js'
import { RemoteSnapshotBuffer } from './RemoteSnapshotBuffer.js'
import { VisualCorrection } from './VisualCorrection.js'

function cloneVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain exactly ${length} finite numbers`)
    return [ ...value ]
}

function cloneWheelContact(contact)
{
    return {
        inContact: contact?.inContact === true,
        contactPoint: contact?.contactPoint === null || contact?.contactPoint === undefined
            ? null
            : cloneVector(contact.contactPoint, 3, 'wheel contact point'),
        suspensionLength: Number.isFinite(contact?.suspensionLength)
            ? contact.suspensionLength
            : null,
    }
}

function cloneVisualState(state)
{
    return {
        ...state,
        entityOrder: Number(state?.entityOrder),
        position: cloneVector(state?.position, 3, 'state.position'),
        quaternion: cloneVector(state?.quaternion, 4, 'state.quaternion'),
        linearVelocity: cloneVector(state?.linearVelocity, 3, 'state.linearVelocity'),
        angularVelocity: cloneVector(state?.angularVelocity, 3, 'state.angularVelocity'),
        wheelRotations: Array.isArray(state?.wheelRotations)
            ? cloneVector(state.wheelRotations, 4, 'state.wheelRotations')
            : [ 0, 0, 0, 0 ],
        wheelContacts: Array.isArray(state?.wheelContacts)
            ? state.wheelContacts.map(cloneWheelContact)
            : [],
    }
}

function splitInterpolationTick(value)
{
    if(value === null || value === undefined)
        return null
    const number = Number(value)
    if(!Number.isFinite(number) || number < 0)
        throw new TypeError('interpolationTick must be a non-negative finite number')
    const base = Math.floor(number)
    return {
        tick: base >>> 0,
        fraction: number - base,
    }
}

export class VehicleVisuals
{
    constructor({
        game,
        predictionWorld,
        localEntityOrder = null,
        physicalVehicle = game?.physicalVehicle,
        vehicleTemplate,
        RemoteVehicleClass = RemoteVehicle,
        SnapshotBufferClass = RemoteSnapshotBuffer,
        correction = new VisualCorrection(),
    } = {})
    {
        if(!predictionWorld || typeof predictionWorld.readState !== 'function')
            throw new TypeError('VehicleVisuals requires a prediction world')
        if(!physicalVehicle || typeof physicalVehicle.setExternalSimulation !== 'function')
            throw new TypeError('VehicleVisuals requires a physical vehicle bridge')
        if(typeof physicalVehicle.applyExternalState !== 'function')
            throw new TypeError('physical vehicle must implement applyExternalState')
        if(typeof RemoteVehicleClass !== 'function')
            throw new TypeError('RemoteVehicleClass must be a constructor')
        if(typeof SnapshotBufferClass !== 'function')
            throw new TypeError('SnapshotBufferClass must be a constructor')
        if(!correction || typeof correction.capture !== 'function')
            throw new TypeError('correction must implement capture')
        if(typeof correction.advance !== 'function' || typeof correction.apply !== 'function')
            throw new TypeError('correction must implement advance and apply')

        this.game = game
        this.predictionWorld = predictionWorld
        this.physicalVehicle = physicalVehicle
        this.vehicleTemplate = vehicleTemplate
        this.RemoteVehicleClass = RemoteVehicleClass
        this.SnapshotBufferClass = SnapshotBufferClass
        this.correction = correction
        this.correctionCount = 0
        this.remoteVehicles = new Map()
        this.remoteBuffers = new Map()
        this.localEntityOrder = null
        this.destroyed = false

        if(localEntityOrder !== null)
            this.setLocalEntityOrder(localEntityOrder)
    }

    setLocalEntityOrder(entityOrder)
    {
        if(this.destroyed)
            throw new Error('VehicleVisuals has been destroyed')

        const next = entityOrder === null ? null : Number(entityOrder)
        if(next !== null && (!Number.isInteger(next) || next < 1 || next > 8))
            throw new TypeError('localEntityOrder must be null or an integer from 1 to 8')
        if(next === this.localEntityOrder)
            return false

        if(this.localEntityOrder !== null)
            this.physicalVehicle.setExternalSimulation(false)

        this.localEntityOrder = next
        if(this.localEntityOrder !== null)
        {
            this.#destroyRemote(this.localEntityOrder)
            this.physicalVehicle.setExternalSimulation(true)
        }
        return true
    }

    reconcile(beforeStates, afterStates, options = {})
    {
        if(this.destroyed)
            return 0
        const count = this.correction.capture(beforeStates, afterStates, options)
        this.correctionCount += count
        return count
    }

    createRemote(entityOrder)
    {
        if(!this.vehicleTemplate)
            throw new Error('vehicleTemplate is required before creating remote vehicles')

        const remote = new this.RemoteVehicleClass(
            this.game,
            entityOrder,
            this.vehicleTemplate,
            { mode: 'authoritative' },
        )
        this.remoteVehicles.set(entityOrder, remote)
        return remote
    }

    ensureRemoteBuffer(entityOrder)
    {
        let buffer = this.remoteBuffers.get(entityOrder)
        if(buffer)
            return buffer
        buffer = new this.SnapshotBufferClass()
        this.remoteBuffers.set(entityOrder, buffer)
        return buffer
    }

    acceptAuthoritativeStateFrame(frame)
    {
        if(this.destroyed)
            return 0
        if(!frame || !Array.isArray(frame.states) || !Array.isArray(frame.events))
            throw new TypeError('state frame must contain states and events arrays')

        const serverTick = Number(frame.serverTick) >>> 0
        for(const state of frame.states)
        {
            if(state.entityOrder === this.localEntityOrder)
                continue
            this.ensureRemoteBuffer(state.entityOrder).push(serverTick, state)
        }

        for(const event of frame.events)
        {
            if(event?.entityOrder === this.localEntityOrder)
                continue
            if(event?.type === ROOM_EVENT_TYPES.SPAWN)
                this.ensureRemoteBuffer(event.entityOrder)
            else if(event?.type === ROOM_EVENT_TYPES.DESPAWN)
                this.#destroyRemote(event.entityOrder)
        }
        return this.remoteBuffers.size
    }

    update(deltaSeconds = 0, interpolationTick = null)
    {
        if(this.destroyed)
            return 0

        this.correction.advance(deltaSeconds)
        let rendered = 0

        if(this.localEntityOrder !== null)
        {
            const sourceState = this.predictionWorld.readState(this.localEntityOrder)
            if(sourceState)
            {
                const state = cloneVisualState(this.correction.apply(sourceState))
                this.physicalVehicle.applyExternalState(state)
                rendered++
            }
        }

        const target = splitInterpolationTick(interpolationTick)
        for(const [ entityOrder, buffer ] of this.remoteBuffers)
        {
            if(entityOrder === this.localEntityOrder)
                continue
            const sourceState = target
                ? buffer.sample(target.tick, target.fraction)
                : buffer.sample(buffer.latestTick ?? 0)
            if(!sourceState)
                continue

            const state = cloneVisualState(sourceState)
            const remote = this.remoteVehicles.get(entityOrder)
                ?? this.createRemote(entityOrder)
            remote.applyAuthoritativeState(state)
            remote.update?.(deltaSeconds)
            rendered++
        }

        return rendered
    }

    #destroyRemote(entityOrder)
    {
        const remote = this.remoteVehicles.get(entityOrder)
        remote?.destroy?.()
        this.remoteVehicles.delete(entityOrder)
        const buffer = this.remoteBuffers.get(entityOrder)
        buffer?.clear?.()
        this.remoteBuffers.delete(entityOrder)
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.destroyed = true
        this.correction.clear?.()
        for(const remote of this.remoteVehicles.values())
            remote.destroy?.()
        this.remoteVehicles.clear()
        for(const buffer of this.remoteBuffers.values())
            buffer.clear?.()
        this.remoteBuffers.clear()

        if(this.localEntityOrder !== null)
            this.physicalVehicle.setExternalSimulation(false)
        this.localEntityOrder = null
    }
}
