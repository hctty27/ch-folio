import { RemoteVehicle } from '../Multiplayer/RemoteVehicle.js'

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
        wheelContacts: Array.isArray(state?.wheelContacts)
            ? state.wheelContacts.map(cloneWheelContact)
            : [],
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

        this.game = game
        this.predictionWorld = predictionWorld
        this.physicalVehicle = physicalVehicle
        this.vehicleTemplate = vehicleTemplate
        this.RemoteVehicleClass = RemoteVehicleClass
        this.remoteVehicles = new Map()
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
            this.physicalVehicle.setExternalSimulation(true)
        return true
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

    update()
    {
        if(this.destroyed)
            return 0

        const states = this.predictionWorld.readState()
        if(!Array.isArray(states))
            throw new TypeError('predictionWorld.readState() must return an array')

        const seenRemotes = new Set()
        for(const sourceState of states)
        {
            const state = cloneVisualState(sourceState)
            if(state.entityOrder === this.localEntityOrder)
            {
                this.physicalVehicle.applyExternalState(state)
                continue
            }

            seenRemotes.add(state.entityOrder)
            const remote = this.remoteVehicles.get(state.entityOrder)
                ?? this.createRemote(state.entityOrder)
            remote.applyAuthoritativeState(state)
            remote.update()
        }

        for(const [ entityOrder, remote ] of this.remoteVehicles)
        {
            if(seenRemotes.has(entityOrder))
                continue

            remote.destroy()
            this.remoteVehicles.delete(entityOrder)
        }

        return states.length
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.destroyed = true
        for(const remote of this.remoteVehicles.values())
            remote.destroy()
        this.remoteVehicles.clear()

        if(this.localEntityOrder !== null)
            this.physicalVehicle.setExternalSimulation(false)
        this.localEntityOrder = null
    }
}
