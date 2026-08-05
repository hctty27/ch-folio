import { discoverSU7WheelNodes } from './SU7WheelNodes.js'

export class SU7FourWheelController
{
    constructor(game)
    {
        this.game = game
        this.items = null
        this.basePositions = null
        this.restPhysicalWheelY = null
        this.steering = 0
        this.warned = false

        this.tickCallback = () => this.update()
        this.game.ticker.events.on('tick', this.tickCallback, 9)
    }

    destroy()
    {
        this.game.ticker.events.off('tick', this.tickCallback)
    }

    setUp()
    {
        const visualVehicle = this.game.world?.visualVehicle
        if(!visualVehicle?.parts?.chassis)
            return false

        const discovery = discoverSU7WheelNodes(visualVehicle.parts.chassis)
        if(!discovery.complete)
        {
            if(!this.warned)
            {
                console.warn('[SU7FourWheelController] four-wheel nodes unavailable; using legacy wheel template', discovery.missing)
                this.warned = true
            }
            return false
        }

        this.items = discovery.items
        this.basePositions = this.items.map(({ container }) => ({
            x: container.position.x,
            y: container.position.y,
            z: container.position.z,
        }))
        this.restPhysicalWheelY = null
        this.visualVehicle = visualVehicle
        this.hideLegacyWheels()
        console.info('[SU7FourWheelController] using four independent SU7 wheel nodes')
        return true
    }

    hideLegacyWheels()
    {
        for(const wheel of this.visualVehicle?.wheels?.items ?? [])
        {
            if(wheel.container)
                wheel.container.visible = false
        }
    }

    getPhysicalWheelY(physicalWheel)
    {
        const wheelY = physicalWheel.basePosition.y - physicalWheel.suspensionLength
        return Math.min(wheelY, -0.5)
    }

    update()
    {
        if(!this.items && !this.setUp())
            return

        const physicalVehicle = this.game.physicalVehicle
        const physicalWheels = physicalVehicle?.wheels?.items
        if(!physicalVehicle || !physicalWheels || physicalWheels.length < 4)
            return

        this.hideLegacyWheels()

        if(!this.restPhysicalWheelY)
            this.restPhysicalWheelY = physicalWheels.map((wheel) => this.getPhysicalWheelY(wheel))

        this.steering += (
            (this.game.player.steering * physicalVehicle.steeringAmplitude) - this.steering
        ) * this.game.ticker.deltaScaled * 16

        const actions = this.game.inputs.actions
        const shouldRoll = !actions.get('brake').active
            || actions.get('forward').active
            || actions.get('backward').active
        const rollDelta = shouldRoll
            ? physicalVehicle.forwardSpeed / physicalVehicle.wheels.settings.radius * 0.006
            : 0

        for(let i = 0; i < this.items.length; i++)
        {
            const visualWheel = this.items[i]
            const physicalWheel = physicalWheels[i]
            const basePosition = this.basePositions[i]

            if(rollDelta !== 0)
                visualWheel.roll.rotation.z += rollDelta

            if(visualWheel.steer)
                visualWheel.steer.rotation.y = this.steering

            const suspensionDelta = this.getPhysicalWheelY(physicalWheel) - this.restPhysicalWheelY[i]
            const targetY = basePosition.y + suspensionDelta

            visualWheel.container.position.x = basePosition.x
            visualWheel.container.position.y += (
                targetY - visualWheel.container.position.y
            ) * 25 * this.game.ticker.deltaScaled
            visualWheel.container.position.z = basePosition.z
        }
    }
}
