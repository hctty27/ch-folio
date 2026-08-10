import { VEHICLE_CONFIG } from '@ch-folio/authoritative-physics'
import { discoverSU7WheelNodes } from '../World/SU7WheelNodes.js'
import { SnapshotBuffer } from './SnapshotBuffer.js'
import { STATE_FLAGS } from './protocol.js'

const WHEEL_RADIUS = VEHICLE_CONFIG.wheels.radius
const STEERING_AMPLITUDE = 0.5
const MAX_FRAME_DELTA = 0.1
const DEFAULT_SUSPENSION_LENGTH = VEHICLE_CONFIG.suspensions.restLength.low

function findByPrefix(root, prefix)
{
    let result = null
    const expression = new RegExp(`^${prefix}`, 'i')

    root?.traverse?.((child) =>
    {
        if(!result && expression.test(child.name))
            result = child
    })

    return result
}

function copyVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain exactly ${length} finite numbers`)
    return [ ...value ]
}

function copyAuthoritativeState(state)
{
    return {
        ...state,
        position: copyVector(state?.position, 3, 'state.position'),
        quaternion: copyVector(state?.quaternion, 4, 'state.quaternion'),
        linearVelocity: copyVector(state?.linearVelocity, 3, 'state.linearVelocity'),
        angularVelocity: copyVector(state?.angularVelocity, 3, 'state.angularVelocity'),
        wheelContacts: Array.isArray(state?.wheelContacts)
            ? state.wheelContacts.map((contact) => ({
                inContact: contact?.inContact === true,
                contactPoint: contact?.contactPoint === null || contact?.contactPoint === undefined
                    ? null
                    : copyVector(contact.contactPoint, 3, 'wheel contact point'),
                suspensionLength: Number.isFinite(contact?.suspensionLength)
                    ? contact.suspensionLength
                    : null,
            }))
            : [],
    }
}

function forwardSpeed(state)
{
    if(Number.isFinite(state?.forwardSpeed))
        return state.forwardSpeed
    if(Number.isFinite(state?.sp))
        return state.sp

    const velocity = state?.linearVelocity
    const quaternion = state?.quaternion
    if(!Array.isArray(velocity) || !Array.isArray(quaternion))
        return 0

    const forward = [
        1 - 2 * (quaternion[1] * quaternion[1] + quaternion[2] * quaternion[2]),
        2 * (quaternion[0] * quaternion[1] + quaternion[2] * quaternion[3]),
        2 * (quaternion[0] * quaternion[2] - quaternion[1] * quaternion[3]),
    ]
    return velocity[0] * forward[0] + velocity[1] * forward[1] + velocity[2] * forward[2]
}

function steeringAngle(state)
{
    if(Number.isFinite(state?.st))
        return state.st * STEERING_AMPLITUDE
    return Number.isFinite(state?.steering) ? state.steering : 0
}

export class RemoteVehicle
{
    constructor(game, playerId, vehicleTemplate, { mode = 'snapshot' } = {})
    {
        if(mode !== 'snapshot' && mode !== 'authoritative')
            throw new TypeError('remote vehicle mode must be snapshot or authoritative')

        this.game = game
        this.playerId = playerId
        this.mode = mode
        this.snapshots = mode === 'snapshot' ? new SnapshotBuffer() : null
        this.authoritativeState = null
        this.wheelRotation = 0
        this.lastUpdateTimestamp = null

        this.model = vehicleTemplate.clone(true)
        this.chassis = findByPrefix(this.model, 'chassis')

        if(!this.chassis)
            throw new Error('Remote vehicle template is missing the chassis node')

        this.chassis.rotation.reorder('YXZ')
        this.chassis.traverse((child) =>
        {
            if(!child.isMesh)
                return

            child.castShadow = true
            child.receiveShadow = true
        })

        this.game.materials.updateObject(this.chassis)
        this.game.scene.add(this.chassis)

        this.stopLights = findByPrefix(this.chassis, 'stopLights')
        this.backLights = findByPrefix(this.chassis, 'backLights')
        this.legacyWheel = findByPrefix(this.chassis, 'wheelContainer')

        const wheelDiscovery = discoverSU7WheelNodes(this.chassis)
        this.wheels = wheelDiscovery.complete ? wheelDiscovery.items : []
        for(const wheel of this.wheels)
            wheel.baseY = wheel.container.position.y

        if(this.wheels.length > 0 && this.legacyWheel)
            this.legacyWheel.visible = false
    }

    pushState(state)
    {
        if(this.mode !== 'snapshot')
            return false
        return this.snapshots.add(state)
    }

    applyAuthoritativeState(state)
    {
        if(this.mode !== 'authoritative')
            return false

        this.authoritativeState = copyAuthoritativeState(state)
        return true
    }

    update(timestamp = Date.now())
    {
        const state = this.mode === 'authoritative'
            ? this.authoritativeState
            : this.snapshots.sample(timestamp)
        if(!state)
            return false

        if(this.mode === 'authoritative')
        {
            this.chassis.position.fromArray(state.position)
            this.chassis.quaternion.fromArray(state.quaternion)
        }
        else
        {
            this.chassis.position.fromArray(state.p)
            this.chassis.quaternion.fromArray(state.q)
        }

        const delta = this.lastUpdateTimestamp === null
            ? 0
            : Math.min(
                MAX_FRAME_DELTA,
                Math.max(0, (timestamp - this.lastUpdateTimestamp) / 1000),
            )
        this.lastUpdateTimestamp = timestamp

        this.wheelRotation += forwardSpeed(state) / WHEEL_RADIUS * delta
        const steering = steeringAngle(state)
        for(let wheelIndex = 0; wheelIndex < this.wheels.length; wheelIndex++)
        {
            const wheel = this.wheels[wheelIndex]
            wheel.roll.rotation.z = this.wheelRotation
            if(wheel.steer)
                wheel.steer.rotation.y = steering

            const suspensionLength = state.wheelContacts?.[wheelIndex]?.suspensionLength
            if(Number.isFinite(suspensionLength))
            {
                wheel.container.position.y = wheel.baseY
                    + DEFAULT_SUSPENSION_LENGTH
                    - suspensionLength
            }
        }

        const braking = this.mode === 'authoritative'
            ? Number(state.brake) > 0
            : (state.f & STATE_FLAGS.BRAKING) !== 0
        if(this.stopLights)
            this.stopLights.visible = braking
        if(this.backLights)
            this.backLights.visible = braking

        return true
    }

    destroy()
    {
        this.snapshots?.clear()
        this.authoritativeState = null
        this.chassis.removeFromParent()
    }
}
