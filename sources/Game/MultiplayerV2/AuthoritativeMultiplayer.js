import {
    FRAME_TYPES,
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeResume,
    decodeStateFrame,
    encodeFullSyncRequest,
    encodeSyncReady,
} from '@ch-folio/authoritative-physics'
import { InputPublisher } from './InputPublisher.js'
import { PredictionWorld } from './PredictionWorld.js'
import { Reconciler } from './Reconciler.js'
import { Server, normalizeRoom } from './Server.js'
import { SyncOverlay } from './SyncOverlay.js'
import { VehicleVisuals } from './VehicleVisuals.js'

const FIXED_DT = 1 / 60
const MAX_CATCH_UP_TICKS = 3
const STORAGE_PREFIX = 'ch-folio:multiplayer:v2:'
const TOKEN_BYTES = 32

export const AUTHORITATIVE_MULTIPLAYER_STATES = Object.freeze({
    CONNECTING: 'connecting',
    SYNCING: 'syncing',
    WAITING_SPAWN: 'waiting_spawn',
    ACTIVE: 'active',
    RECONNECTING: 'reconnecting',
    INCOMPATIBLE: 'incompatible',
    STOPPED: 'stopped',
})

function defaultStorage()
{
    try
    {
        return globalThis.sessionStorage ?? null
    }
    catch
    {
        return null
    }
}

function uint32(value)
{
    return Number(value) >>> 0
}

function bytesToBase64Url(value)
{
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    let binary = ''
    for(const byte of bytes)
        binary += String.fromCharCode(byte)
    return globalThis.btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '')
}

function base64UrlToBytes(value)
{
    if(typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value))
        throw new TypeError('resume token must be a 256-bit base64url value')

    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='
    const binary = globalThis.atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    if(bytes.byteLength !== TOKEN_BYTES)
        throw new TypeError('resume token must contain exactly 32 bytes')
    return bytes
}

function copyCredential(value)
{
    if(!value || !Number.isInteger(value.playerId) || value.playerId <= 0)
        return null
    if(!Number.isInteger(value.lastServerTick) || value.lastServerTick < 0)
        return null

    try
    {
        return {
            playerId: uint32(value.playerId),
            lastServerTick: uint32(value.lastServerTick),
            resumeToken: base64UrlToBytes(value.resumeToken),
        }
    }
    catch
    {
        return null
    }
}

export function credentialStorageKey(room)
{
    return `${STORAGE_PREFIX}${normalizeRoom(room)}`
}

export class AuthoritativeMultiplayer
{
    constructor(game, {
        server = null,
        storage = defaultStorage(),
        serverUrl = import.meta.env?.VITE_SERVER_URL ?? null,
        PredictionWorldClass = PredictionWorld,
        VehicleVisualsClass = VehicleVisuals,
        ReconcilerClass = Reconciler,
        InputPublisherClass = InputPublisher,
        SyncOverlayClass = SyncOverlay,
    } = {})
    {
        this.game = game
        this.server = server ?? new Server()
        this.storage = storage
        this.serverUrl = serverUrl
        this.PredictionWorldClass = PredictionWorldClass
        this.VehicleVisualsClass = VehicleVisualsClass
        this.ReconcilerClass = ReconcilerClass
        this.InputPublisherClass = InputPublisherClass

        this.overlay = new SyncOverlayClass()
        this.state = AUTHORITATIVE_MULTIPLAYER_STATES.STOPPED
        this.overlay.setState(this.state)

        this.started = false
        this.destroyed = false
        this.listenersBound = false
        this.room = null
        this.storageKey = null
        this.playerId = null
        this.localEntityOrder = null
        this.lastServerTick = 0
        this.resumeToken = null
        this.pendingFullSync = null
        this.predictionWorld = null
        this.visuals = null
        this.reconciler = null
        this.inputPublisher = null
        this.accumulator = 0
        this.frameQueue = Promise.resolve()

        this.tickCallback = () => this.update()
        this.frameCallback = (frame) => this.enqueueFrame(frame)
        this.connectedCallback = () => this.onConnected()
        this.disconnectedCallback = () => this.onDisconnected()
        this.errorCallback = (error) => this.onTransportError(error)

        this.game?.ticker?.events?.on('tick', this.tickCallback, 10)
    }

    setState(state, detail = null)
    {
        if(this.state === state && detail === null)
            return false
        this.state = state
        this.overlay.setState(state, detail)
        return true
    }

    start({ room } = {})
    {
        if(this.destroyed || this.started || !room || !this.serverUrl)
            return false

        this.room = normalizeRoom(room)
        this.storageKey = credentialStorageKey(this.room)
        const resume = this.readCredential()

        this.started = true
        this.bindServerEvents()
        this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.CONNECTING)

        const started = this.server.start({
            url: this.serverUrl,
            room: this.room,
            resume,
        })
        if(!started)
        {
            this.started = false
            this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.STOPPED)
        }
        return started
    }

    stop()
    {
        if(!this.started && this.state === AUTHORITATIVE_MULTIPLAYER_STATES.STOPPED)
            return false

        this.started = false
        this.removeCredential()
        this.server.stop()
        this.clearRuntime()
        this.playerId = null
        this.resumeToken = null
        this.lastServerTick = 0
        this.pendingFullSync = null
        this.accumulator = 0
        this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.STOPPED)
        return true
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.stop()
        this.destroyed = true
        this.unbindServerEvents()
        this.game?.ticker?.events?.off('tick', this.tickCallback)
        this.overlay.destroy()
    }

    bindServerEvents()
    {
        if(this.listenersBound)
            return

        this.listenersBound = true
        this.server.events.on('frame', this.frameCallback)
        this.server.events.on('connected', this.connectedCallback)
        this.server.events.on('disconnected', this.disconnectedCallback)
        this.server.events.on('error', this.errorCallback)
    }

    unbindServerEvents()
    {
        if(!this.listenersBound)
            return

        this.listenersBound = false
        this.server.events.off('frame', this.frameCallback)
        this.server.events.off('connected', this.connectedCallback)
        this.server.events.off('disconnected', this.disconnectedCallback)
        this.server.events.off('error', this.errorCallback)
    }

    onConnected()
    {
        if(!this.started)
            return
        this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.SYNCING)
    }

    onDisconnected()
    {
        if(!this.started || this.state === AUTHORITATIVE_MULTIPLAYER_STATES.INCOMPATIBLE)
            return
        this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.RECONNECTING)
    }

    onTransportError(error)
    {
        const message = String(error?.message ?? error ?? '')
        if(!/incompatible/i.test(message))
            return

        this.started = false
        this.removeCredential()
        this.server.stop()
        this.clearRuntime()
        this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.INCOMPATIBLE, message)
    }

    enqueueFrame(frame)
    {
        this.frameQueue = this.frameQueue
            .then(() => this.handleFrame(frame))
            .catch((error) => this.handleFrameFailure(error))
        return this.frameQueue
    }

    whenIdle()
    {
        return this.frameQueue
    }

    async handleFrame(frame)
    {
        if(!this.started || !(frame instanceof Uint8Array) || frame.byteLength < 1)
            return

        switch(frame[0])
        {
            case FRAME_TYPES.RESUME:
                this.acceptGrant(decodeResume(frame))
                break

            case FRAME_TYPES.FULL_SYNC:
                this.pendingFullSync = decodeFullSyncFrame(frame)
                this.tryApplyPendingFullSync()
                break

            case FRAME_TYPES.STATE:
                await this.acceptStateFrame(decodeStateFrame(frame))
                break

            case FRAME_TYPES.ERROR:
                this.acceptErrorFrame(decodeErrorFrame(frame))
                break

            default:
                throw new TypeError(`unexpected authoritative frame type ${frame[0]}`)
        }
    }

    handleFrameFailure(error)
    {
        const message = String(error?.message ?? error ?? 'authoritative lifecycle failure')
        if(/incompatible/i.test(message))
        {
            this.onTransportError(error)
            return
        }

        if(this.started)
            this.requestFullSync('frame-processing-failed')
    }

    acceptGrant(grant)
    {
        this.playerId = uint32(grant.playerId)
        this.lastServerTick = uint32(grant.lastServerTick)
        this.resumeToken = Uint8Array.from(grant.resumeToken)
        this.writeCredential()
        this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.SYNCING)
    }

    acceptErrorFrame(error)
    {
        const message = String(error.message ?? '')
        if(message === 'HELLO_REQUIRED')
            return

        if(message === 'INVALID_RESUME')
        {
            this.removeCredential()
            this.playerId = null
            this.resumeToken = null
            this.server.stop()
            if(this.started)
            {
                this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.CONNECTING)
                this.server.start({
                    url: this.serverUrl,
                    room: this.room,
                    resume: null,
                })
            }
            return
        }

        if(/incompatible/i.test(message))
        {
            this.onTransportError(new Error(message))
            return
        }

        this.overlay.setState(this.state, message)
    }

    resolveVehicleTemplate()
    {
        return this.game?.remoteVehicleTemplate
            ?? this.game?.world?.visualVehicle?.parts?.chassis
            ?? null
    }

    runtimeReady()
    {
        return Boolean(
            this.game?.RAPIER
            && this.game?.physicalVehicle
            && this.resolveVehicleTemplate(),
        )
    }

    tryApplyPendingFullSync()
    {
        const sync = this.pendingFullSync
        if(sync === null || this.playerId === null || !this.runtimeReady())
            return false

        const descriptor = sync.entities.find((entity) => entity.playerId === this.playerId)
        if(!descriptor)
            throw new Error('full sync does not contain the local player descriptor')

        this.clearRuntime()
        this.localEntityOrder = descriptor.entityOrder
        this.predictionWorld = new this.PredictionWorldClass({
            RAPIER: this.game.RAPIER,
        })
        this.visuals = new this.VehicleVisualsClass({
            game: this.game,
            predictionWorld: this.predictionWorld,
            localEntityOrder: this.localEntityOrder,
            physicalVehicle: this.game.physicalVehicle,
            vehicleTemplate: this.resolveVehicleTemplate(),
        })
        this.reconciler = new this.ReconcilerClass({
            predictionWorld: this.predictionWorld,
            localEntityOrder: this.localEntityOrder,
            requestFullSync: (reason) => this.requestFullSync(reason),
            acknowledgeInput: (sequence) => this.inputPublisher?.acknowledge(sequence),
            reconcileVisuals: (before, after, options) =>
                this.visuals?.reconcile(before, after, options),
        })
        this.inputPublisher = new this.InputPublisherClass(this.game, {
            isActive: () => this.state === AUTHORITATIVE_MULTIPLAYER_STATES.ACTIVE,
            recordPredictionInput: () => {},
            sendFrame: (frame) => this.server.sendFrame(frame),
        })

        this.reconciler.applyFullSync(sync)
        this.pendingFullSync = null
        this.lastServerTick = uint32(sync.serverTick)
        this.accumulator = 0
        this.writeCredential()
        this.server.sendFrame(encodeSyncReady())
        this.refreshSpawnState()
        return true
    }

    async acceptStateFrame(frame)
    {
        if(!this.reconciler)
        {
            this.requestFullSync('state-before-full-sync')
            return
        }

        await this.reconciler.reconcileState(frame)
        this.lastServerTick = uint32(frame.serverTick)
        this.writeCredential()
        this.refreshSpawnState()
    }

    refreshSpawnState()
    {
        if(!this.predictionWorld || this.localEntityOrder === null)
        {
            this.setState(AUTHORITATIVE_MULTIPLAYER_STATES.SYNCING)
            return false
        }

        const active = this.predictionWorld.readState()
            .some((state) => state.entityOrder === this.localEntityOrder)
        this.setState(active
            ? AUTHORITATIVE_MULTIPLAYER_STATES.ACTIVE
            : AUTHORITATIVE_MULTIPLAYER_STATES.WAITING_SPAWN)
        return active
    }

    requestFullSync(reason)
    {
        void reason
        return this.server.sendFrame(encodeFullSyncRequest())
    }

    update()
    {
        if(!this.started || this.destroyed)
            return

        if(this.pendingFullSync !== null)
            this.tryApplyPendingFullSync()
        if(!this.reconciler || !this.predictionWorld || !this.inputPublisher)
            return

        const delta = Math.max(0, Number(this.game?.ticker?.delta ?? 0))
        this.accumulator += Math.min(delta, FIXED_DT * MAX_CATCH_UP_TICKS)

        let advanced = 0
        while(this.accumulator + Number.EPSILON >= FIXED_DT && advanced < MAX_CATCH_UP_TICKS)
        {
            const tick = (this.predictionWorld.tick + 1) >>> 0
            const input = this.inputPublisher.sample(tick)
            this.reconciler.predict({
                inputs: [ {
                    entityOrder: this.localEntityOrder,
                    input,
                } ],
            })
            this.accumulator -= FIXED_DT
            advanced++
        }

        if(this.state === AUTHORITATIVE_MULTIPLAYER_STATES.ACTIVE)
            this.visuals?.update(delta)
    }

    clearRuntime()
    {
        this.reconciler?.destroy()
        this.visuals?.destroy()
        this.predictionWorld?.destroy()
        this.reconciler = null
        this.visuals = null
        this.predictionWorld = null
        this.inputPublisher = null
        this.localEntityOrder = null
    }

    readCredential()
    {
        if(!this.storage || !this.storageKey)
            return null

        try
        {
            const stored = this.storage.getItem(this.storageKey)
            if(stored === null)
                return null
            const credential = copyCredential(JSON.parse(stored))
            if(credential === null)
            {
                this.storage.removeItem(this.storageKey)
                return null
            }
            return credential
        }
        catch
        {
            return null
        }
    }

    writeCredential()
    {
        if(
            !this.storage
            || !this.storageKey
            || this.playerId === null
            || this.resumeToken === null
        )
            return false

        try
        {
            this.storage.setItem(this.storageKey, JSON.stringify({
                playerId: this.playerId,
                lastServerTick: this.lastServerTick,
                resumeToken: bytesToBase64Url(this.resumeToken),
            }))
            return true
        }
        catch
        {
            return false
        }
    }

    removeCredential()
    {
        if(!this.storage || !this.storageKey)
            return false
        try
        {
            this.storage.removeItem(this.storageKey)
            return true
        }
        catch
        {
            return false
        }
    }
}
