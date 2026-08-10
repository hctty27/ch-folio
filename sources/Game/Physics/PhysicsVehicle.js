import * as THREE from 'three/webgpu'
import {
    VEHICLE_CONFIG,
    unpackSuspensions,
} from '@ch-folio/authoritative-physics'
import { PhysicsVehicle as PhysicsVehicleLegacy } from './PhysicsVehicleLegacy.js'

function finiteVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain exactly ${length} finite numbers`)
    return value
}

function copyContactPoint(value)
{
    if(value === null || value === undefined)
        return null
    finiteVector(value, 3, 'wheel contact point')
    return new THREE.Vector3().fromArray(value)
}

export class PhysicsVehicle extends PhysicsVehicleLegacy
{
    constructor(...args)
    {
        super(...args)
        this.externalSimulation = false
        this.externalLinearVelocity = new THREE.Vector3()
        this.externalAngularVelocity = new THREE.Vector3()
        this.externalSteering = 0
    }

    setExternalSimulation(active)
    {
        const next = active === true
        if(next === this.externalSimulation)
            return false

        this.externalSimulation = next
        const body = this.chassis.physical.body
        body.setEnabled(!this.externalSimulation)

        if(!this.externalSimulation)
        {
            body.setTranslation(this.position, true)
            body.setRotation(this.quaternion, true)
            body.setLinvel(this.externalLinearVelocity, true)
            body.setAngvel(this.externalAngularVelocity, true)
            this.controller.setWheelSteering(0, this.externalSteering)
            this.controller.setWheelSteering(1, this.externalSteering)
        }

        return true
    }

    updatePrePhysics()
    {
        if(this.externalSimulation)
            return
        return super.updatePrePhysics()
    }

    updatePostPhysics()
    {
        if(this.externalSimulation)
            return
        return super.updatePostPhysics()
    }

    applyExternalState(state)
    {
        if(!this.externalSimulation)
            throw new Error('external simulation mode is not active')

        const position = finiteVector(state?.position, 3, 'state.position')
        const quaternion = finiteVector(state?.quaternion, 4, 'state.quaternion')
        const linearVelocity = finiteVector(state?.linearVelocity, 3, 'state.linearVelocity')
        const angularVelocity = finiteVector(state?.angularVelocity, 3, 'state.angularVelocity')

        this.position.fromArray(position)
        this.quaternion.fromArray(quaternion).normalize()
        this.externalLinearVelocity.fromArray(linearVelocity)
        this.externalAngularVelocity.fromArray(angularVelocity)
        this.velocity.copy(this.externalLinearVelocity).multiplyScalar(VEHICLE_CONFIG.fixedDt)

        this.speed = Number.isFinite(state?.speed)
            ? Math.max(0, state.speed)
            : this.externalLinearVelocity.length()
        this.xzSpeed = Math.hypot(this.externalLinearVelocity.x, this.externalLinearVelocity.z)

        if(this.speed > 0)
            this.direction.copy(this.externalLinearVelocity).normalize()
        else
            this.direction.set(0, 0, 0)

        this.sideward.set(0, 0, 1).applyQuaternion(this.quaternion)
        this.upward.set(0, 1, 0).applyQuaternion(this.quaternion)
        this.forward.set(1, 0, 0).applyQuaternion(this.quaternion)
        this.forwardRatio = this.speed > 0 ? this.direction.dot(this.forward) : 1
        this.goingForward = state?.goingForward ?? this.forwardRatio >= 0
        this.forwardSpeed = Number.isFinite(state?.forwardSpeed)
            ? state.forwardSpeed
            : this.externalLinearVelocity.dot(this.forward)

        this.xRotation = new THREE.Euler().setFromQuaternion(this.quaternion, 'XYZ').x
        this.yRotation = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ').y
        this.zRotation = new THREE.Euler().setFromQuaternion(this.quaternion, 'ZYX').z
        this.externalSteering = Number.isFinite(state?.steering) ? state.steering : 0

        const suspensionStates = unpackSuspensions(Number(state?.suspensions ?? 0))
        const contacts = Array.isArray(state?.wheelContacts) ? state.wheelContacts : []
        let inContactCount = 0
        let justTouchedCount = 0

        for(let wheelIndex = 0; wheelIndex < this.wheels.items.length; wheelIndex++)
        {
            const wheel = this.wheels.items[wheelIndex]
            const contact = contacts[wheelIndex]
            const wasInContact = wheel.inContact
            wheel.suspensionState = suspensionStates[wheelIndex]
            wheel.inContact = contact?.inContact === true
            wheel.contactPoint = copyContactPoint(contact?.contactPoint)
            wheel.suspensionLength = Number.isFinite(contact?.suspensionLength)
                ? contact.suspensionLength
                : VEHICLE_CONFIG.suspensions.restLength[wheel.suspensionState]

            if(wheel.inContact)
            {
                inContactCount++
                if(!wasInContact)
                {
                    justTouchedCount++
                    wheel.lastTouchTime = this.game.ticker.elapsed
                }
            }
        }

        this.wheels.inContactCount = inContactCount
        this.wheels.justTouchedCount = justTouchedCount
        this.stop.test()
        this.upsideDown.test()
        this.stuck.test()
        this.flip.test()
        return this
    }
}
