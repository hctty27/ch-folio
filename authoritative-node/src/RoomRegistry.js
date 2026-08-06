export class RoomRegistry
{
    constructor({ roomFactory } = {})
    {
        if(typeof roomFactory !== 'function')
            throw new TypeError('roomFactory must be a function')
        this.roomFactory = roomFactory
        this.rooms = new Map()
        this.stopping = false
    }

    get size()
    {
        return this.rooms.size
    }

    has(room)
    {
        return this.rooms.has(room)
    }

    get(room)
    {
        return this.rooms.get(room) ?? null
    }

    getOrCreate(room)
    {
        if(this.stopping)
            throw new Error('room registry is stopping')
        let instance = this.rooms.get(room)
        if(instance !== undefined)
            return instance

        instance = this.roomFactory(room, (candidate) =>
        {
            this.deleteIfEmpty(room, candidate)
        })
        this.rooms.set(room, instance)
        return instance
    }

    deleteIfEmpty(room, instance)
    {
        if(this.rooms.get(room) !== instance || !instance?.isEmpty)
            return false
        this.rooms.delete(room)
        return true
    }

    activeSocketCount()
    {
        let total = 0
        for(const room of this.rooms.values())
            total += Number(room.activeSocketCount ?? 0)
        return total
    }

    async stop()
    {
        if(this.stopping && this.rooms.size === 0)
            return
        this.stopping = true
        const rooms = Array.from(this.rooms.values())
        this.rooms.clear()
        await Promise.all(rooms.map((room) => room.destroy()))
    }
}
