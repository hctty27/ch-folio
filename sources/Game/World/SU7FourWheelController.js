import { discoverSU7WheelNodes } from './SU7WheelNodes.js'

const SU7_VISUAL_WHEELBASE_SCALE = 1.05 / 0.9

export class SU7FourWheelController
{
    constructor(game)
    {
        this.game = game
        this.items = null
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

    update()
    {
        if(!this.items && !this.setUp())
            return

        const physicalVehicle = this.game.physicalVehicle
        const physicalWheels = physicalVehicle?.wheels?.items
        if(!physicalVehicle || !physicalWheels || physicalWheels.length < 4)
            return

        this.hideLegacyWheels()

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

            if(rollDelta !== 0)
                visualWheel.roll.rotation.z += rollDelta

            if(visualWheel.steer)
                visualWheel.steer.rotation.y = this.steering

            const suspensionLength = physicalWheel.suspensionLength
            let wheelY = physicalWheel.basePosition.y - suspensionLength
            wheelY = Math.min(wheelY, -0.5)

            visualWheel.container.position.x = physicalWheel.basePosition.x * SU7_VISUAL_WHEELBASE_SCALE
            visualWheel.container.position.y += (
                wheelY - visualWheel.container.position.y
            ) * 25 * this.game.ticker.deltaScaled
            visualWheel.container.position.z = physicalWheel.basePosition.z
        }
    }
}
