import { discoverSU7WheelNodes } from '../World/SU7WheelNodes.js'
import { SnapshotBuffer } from './SnapshotBuffer.js'
import { STATE_FLAGS } from './protocol.js'

const WHEEL_RADIUS = 0.4
const STEERING_AMPLITUDE = 0.5
const MAX_FRAME_DELTA = 0.1

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

export class RemoteVehicle
{
    constructor(game, playerId, vehicleTemplate)
    {
        this.game = game
        this.playerId = playerId
        this.snapshots = new SnapshotBuffer()
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

        if(this.wheels.length > 0 && this.legacyWheel)
            this.legacyWheel.visible = false
    }

    pushState(state)
    {
        return this.snapshots.add(state)
    }

    update(timestamp = Date.now())
    {
        const state = this.snapshots.sample(timestamp)
        if(!state)
            return false

        this.chassis.position.fromArray(state.p)
        this.chassis.quaternion.fromArray(state.q)

        const delta = this.lastUpdateTimestamp === null
            ? 0
            : Math.min(
                MAX_FRAME_DELTA,
                Math.max(0, (timestamp - this.lastUpdateTimestamp) / 1000),
            )
        this.lastUpdateTimestamp = timestamp

        this.wheelRotation += state.sp / WHEEL_RADIUS * delta
        for(const wheel of this.wheels)
        {
            wheel.roll.rotation.z = this.wheelRotation
            if(wheel.steer)
                wheel.steer.rotation.y = state.st * STEERING_AMPLITUDE
        }

        const braking = (state.f & STATE_FLAGS.BRAKING) !== 0
        if(this.stopLights)
            this.stopLights.visible = braking
        if(this.backLights)
            this.backLights.visible = braking

        return true
    }

    destroy()
    {
        this.snapshots.clear()
        this.chassis.removeFromParent()
    }
}
