import { MESSAGE_TYPES, STATE_FLAGS, createStateMessage } from './protocol.js'
import { RemotePlayers } from './RemotePlayers.js'
import { MultiplayerServer } from './Server.js'

export const STATE_UPLOAD_HZ = 12
const STATE_UPLOAD_INTERVAL = 1 / STATE_UPLOAD_HZ

const enabledAction = (actions, name) => actions?.get(name)?.active === true

export class Multiplayer
{
    constructor(game)
    {
        this.game = game
        this.server = new MultiplayerServer(game)
        this.remotePlayers = new RemotePlayers(game)
        this.started = false
        this.listenersBound = false
        this.playerId = null
        this.clockOffset = 0
        this.sequence = 0
        this.lastSentAt = -Infinity
        this.invalidStateWarned = false

        this.tickCallback = () => this.update()
        this.messageCallback = (message) => this.onMessage(message)
        this.connectedCallback = () => this.onConnected()
        this.disconnectedCallback = () => this.onDisconnected()
        this.errorCallback = (error) => console.warn('[Multiplayer] transport error', error)

        this.game.ticker.events.on('tick', this.tickCallback, 10)
    }

    start()
    {
        if(this.started)
            return false

        this.started = true
        this.bindServerEvents()
        const started = this.server.start({
            url: import.meta.env.VITE_SERVER_URL,
            room: import.meta.env.VITE_MULTIPLAYER_ROOM || 'public',
        })

        if(!started)
            this.started = false

        return started
    }

    stop()
    {
        if(!this.started)
            return false

        this.started = false
        this.playerId = null
        this.remotePlayers.clear()
        this.server.stop()
        return true
    }

    destroy()
    {
        this.stop()
        this.game.ticker.events.off('tick', this.tickCallback)
        this.unbindServerEvents()
    }

    bindServerEvents()
    {
        if(this.listenersBound)
            return

        this.listenersBound = true
        this.server.events.on('message', this.messageCallback)
        this.server.events.on('connected', this.connectedCallback)
        this.server.events.on('disconnected', this.disconnectedCallback)
        this.server.events.on('error', this.errorCallback)
    }

    unbindServerEvents()
    {
        if(!this.listenersBound)
            return

        this.listenersBound = false
        this.server.events.off('message', this.messageCallback)
        this.server.events.off('connected', this.connectedCallback)
        this.server.events.off('disconnected', this.disconnectedCallback)
        this.server.events.off('error', this.errorCallback)
    }

    onConnected()
    {
        this.sequence = 0
        this.lastSentAt = -Infinity
        this.invalidStateWarned = false
    }

    onDisconnected()
    {
        this.playerId = null
        this.remotePlayers.clear()
    }

    resolveVehicleTemplate()
    {
        if(this.game.remoteVehicleTemplate)
            return true

        const chassis = this.game.world?.visualVehicle?.parts?.chassis
        if(!chassis)
            return false

        this.game.remoteVehicleTemplate = chassis
        return true
    }

    normalizeIncomingState(message)
    {
        return {
            seq: message.seq,
            ts: message.ts + this.clockOffset,
            p: message.p,
            q: message.q,
            st: message.st,
            sp: message.sp,
            f: message.f,
        }
    }

    onMessage(message)
    {
        if(!message || message.v !== 1)
            return

        if(message.t === MESSAGE_TYPES.WELCOME)
        {
            this.playerId = message.id
            this.clockOffset = Date.now() - message.ts

            for(const player of message.players ?? [])
            {
                if(player.id && player.id !== this.playerId && player.p)
                    this.remotePlayers.upsert(player.id, this.normalizeIncomingState(player))
            }
            return
        }

        if(message.t === MESSAGE_TYPES.STATE)
        {
            if(message.id && message.id !== this.playerId)
                this.remotePlayers.upsert(message.id, this.normalizeIncomingState(message))
            return
        }

        if(message.t === MESSAGE_TYPES.LEFT)
        {
            this.remotePlayers.remove(message.id)
            return
        }

        if(message.t === MESSAGE_TYPES.ERROR)
            console.warn('[Multiplayer] server rejected a message', message.message)
    }

    createFlags()
    {
        let flags = 0
        const actions = this.game.inputs?.actions

        if(this.game.player?.braking > 0)
            flags |= STATE_FLAGS.BRAKING
        if(this.game.player?.boosting > 0)
            flags |= STATE_FLAGS.BOOSTING
        if(enabledAction(actions, 'honk'))
            flags |= STATE_FLAGS.HONKING
        if(this.game.player?.steering < -0.1)
            flags |= STATE_FLAGS.STEERING_LEFT
        if(this.game.player?.steering > 0.1)
            flags |= STATE_FLAGS.STEERING_RIGHT

        return flags
    }

    publishState()
    {
        const vehicle = this.game.physicalVehicle
        const player = this.game.player
        if(!vehicle || !player)
            return false

        try
        {
            const message = createStateMessage({
                sequence: ++this.sequence,
                timestamp: Date.now(),
                position: vehicle.position.toArray(),
                quaternion: vehicle.quaternion.toArray(),
                steering: player.steering,
                forwardSpeed: vehicle.forwardSpeed,
                flags: this.createFlags(),
            })

            this.invalidStateWarned = false
            return this.server.send(message)
        }
        catch(error)
        {
            if(!this.invalidStateWarned)
            {
                console.warn('[Multiplayer] skipped invalid local vehicle state', error)
                this.invalidStateWarned = true
            }
            return false
        }
    }

    update()
    {
        const now = Date.now()
        this.resolveVehicleTemplate()
        this.remotePlayers.update(now)

        if(!this.started || !this.server.connected)
            return

        const elapsed = this.game.ticker.elapsed
        if(elapsed - this.lastSentAt < STATE_UPLOAD_INTERVAL)
            return

        if(this.publishState())
            this.lastSentAt = elapsed
    }
}
