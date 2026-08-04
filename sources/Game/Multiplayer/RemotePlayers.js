import { RemoteVehicle } from './RemoteVehicle.js'

export class RemotePlayers
{
    constructor(game)
    {
        this.game = game
        this.items = new Map()
    }

    upsert(playerId, state)
    {
        if(!playerId || !state || !this.game.remoteVehicleTemplate)
            return false

        let vehicle = this.items.get(playerId)
        if(!vehicle)
        {
            vehicle = new RemoteVehicle(
                this.game,
                playerId,
                this.game.remoteVehicleTemplate,
            )
            this.items.set(playerId, vehicle)
        }

        return vehicle.pushState(state)
    }

    remove(playerId)
    {
        const vehicle = this.items.get(playerId)
        if(!vehicle)
            return false

        vehicle.destroy()
        this.items.delete(playerId)
        return true
    }

    clear()
    {
        for(const vehicle of this.items.values())
            vehicle.destroy()

        this.items.clear()
    }

    update(timestamp = Date.now())
    {
        for(const vehicle of this.items.values())
            vehicle.update(timestamp)
    }
}
