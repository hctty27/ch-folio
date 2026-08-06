import mapSource from '../../../packages/authoritative-physics/generated/map-v1.json'
import RAPIER from '@dimforge/rapier3d'
import {
    AuthoritativeWorld,
    RoomSimulation,
    decodeHello,
    decodeResume,
    encodeErrorFrame,
    encodeFullSyncFrame,
    encodeResume,
    encodeStateFrame,
    hashWorldSnapshot,
    loadAuthoritativeMap,
} from '@ch-folio/authoritative-physics'
import { DurableObject } from 'cloudflare:workers'
import {
    resumeTokenFromBytes,
    resumeTokenToBytes,
} from './crypto'
import { Metrics } from './Metrics'
import {
    SessionRegistry,
    type SessionGrant,
} from './SessionRegistry'
import { TickScheduler } from './TickScheduler'

const HELLO_REQUIRED_CODE = 1
const INVALID_HANDSHAKE_CODE = 2
const UNEXPECTED_FRAME_CODE = 3
const ROOM_FULL_CODE = 4
const INVALID_RESUME_CODE = 5
const STALE_CONNECTION_CODE = 6
const SESSION_FAILURE_CODE = 7

const HELLO_REQUIRED_MESSAGE = 'HELLO_REQUIRED'
const INVALID_HANDSHAKE_MESSAGE = 'INVALID_HANDSHAKE'
const UNEXPECTED_FRAME_MESSAGE = 'UNEXPECTED_FRAME'
const ROOM_FULL_MESSAGE = 'ROOM_FULL'
const INVALID_RESUME_MESSAGE = 'INVALID_RESUME'
const STALE_CONNECTION_MESSAGE = 'STALE_CONNECTION'
const SESSION_FAILURE_MESSAGE = 'SESSION_FAILURE'

const STATE_BROADCAST_INTERVAL_TICKS = 3
const WORLD_HASH_INTERVAL_TICKS = 60

const RAPIER_TIMING_METHODS = Object.freeze({
    rapierBroadPhase: 'timingBroadPhase',
    rapierNarrowPhase: 'timingNarrowPhase',
    rapierCcd: 'timingCcd',
    rapierSolver: 'timingSolver',
} as const)

type HandshakeState =
    | 'awaiting_handshake'
    | 'processing_handshake'
    | 'session_active'

type AuthoritativeSocketAttachment = {
    protocolVersion: 2
    handshake: HandshakeState
    clientTick: number | null
    playerId: number | null
    entityOrder: number | null
    generation: number | null
}

type WorldHash = {
    hashTick: number
    sha256: Uint8Array
}

type QueueSlot = {
    queuedInputs?: Map<number, unknown>
} | null

function json(data: unknown, status = 200): Response
{
    return Response.json(data, {
        status,
        headers: {
            'cache-control': 'no-store',
        },
    })
}

function createAttachment(): AuthoritativeSocketAttachment
{
    return {
        protocolVersion: 2,
        handshake: 'awaiting_handshake',
        clientTick: null,
        playerId: null,
        entityOrder: null,
        generation: null,
    }
}

function isUint32(value: unknown): value is number
{
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
}

function isEntityOrder(value: unknown): value is number
{
    return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 8
}

export class AuthoritativeGameRoom extends DurableObject<Env>
{
    private readonly sessions = new SessionRegistry()
    private readonly metrics = new Metrics()
    private readonly scheduler = new TickScheduler({
        metrics: this.metrics,
        onTick: () => this.advanceOneTick(),
    })
    private authoritativeMap: ReturnType<typeof loadAuthoritativeMap> | null = null
    private authoritativeWorld: AuthoritativeWorld | null = null
    private simulation: RoomSimulation | null = null
    private currentTick = 0
    private eventCursor = 0
    private lastRapierStepMs = 0
    private runtimeGeneration = 0
    private completedWorldHash: WorldHash | null = null
    private readonly completedWorldHashQueue: WorldHash[] = []
    private rapierInternalTimingAvailable = false

    async fetch(request: Request): Promise<Response>
    {
        if(request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
            return json({ ok: false, error: 'websocket_upgrade_required' }, 426)

        const pair = new WebSocketPair()
        const [ client, server ] = Object.values(pair)
        const attachment = createAttachment()

        this.ctx.acceptWebSocket(server)
        server.serializeAttachment(attachment)
        server.send(encodeErrorFrame({
            code: HELLO_REQUIRED_CODE,
            retryable: true,
            contextTick: this.currentTick,
            message: HELLO_REQUIRED_MESSAGE,
        }))

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    async webSocketMessage(
        socket: WebSocket,
        message: string | ArrayBuffer,
    ): Promise<void>
    {
        const decodeStarted = performance.now()
        try
        {
            const attachment = this.getAttachment(socket)

            if(attachment.handshake === 'processing_handshake')
            {
                this.rejectSocket(
                    socket,
                    UNEXPECTED_FRAME_CODE,
                    UNEXPECTED_FRAME_MESSAGE,
                    1008,
                )
                return
            }

            if(attachment.handshake === 'session_active')
            {
                if(
                    attachment.playerId === null
                    || attachment.generation === null
                    || !this.sessions.isCurrentController(
                        attachment.playerId,
                        attachment.generation,
                    )
                )
                {
                    this.rejectSocket(
                        socket,
                        STALE_CONNECTION_CODE,
                        STALE_CONNECTION_MESSAGE,
                        1008,
                    )
                    return
                }

                this.rejectSocket(
                    socket,
                    UNEXPECTED_FRAME_CODE,
                    UNEXPECTED_FRAME_MESSAGE,
                    1008,
                )
                return
            }

            if(typeof message === 'string')
            {
                this.rejectSocket(
                    socket,
                    INVALID_HANDSHAKE_CODE,
                    INVALID_HANDSHAKE_MESSAGE,
                    1003,
                )
                return
            }

            try
            {
                const hello = decodeHello(message)
                socket.serializeAttachment({
                    ...attachment,
                    handshake: 'processing_handshake',
                    clientTick: hello.clientTick,
                } satisfies AuthoritativeSocketAttachment)
                await this.createNewSession(socket, hello.clientTick)
                return
            }
            catch
            {
                // The first binary frame may be RESUME instead of HELLO.
            }

            try
            {
                const resume = decodeResume(message)
                socket.serializeAttachment({
                    ...attachment,
                    handshake: 'processing_handshake',
                } satisfies AuthoritativeSocketAttachment)
                await this.resumeSession(
                    socket,
                    resume.playerId,
                    resumeTokenFromBytes(resume.resumeToken),
                )
                return
            }
            catch(error)
            {
                console.warn('[AuthoritativeGameRoom] Invalid handshake frame', error)
                this.rejectSocket(
                    socket,
                    INVALID_HANDSHAKE_CODE,
                    INVALID_HANDSHAKE_MESSAGE,
                    1002,
                )
            }
        }
        finally
        {
            this.metrics.recordPhase('decode', performance.now() - decodeStarted)
        }
    }

    webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
    ): void
    {
        void code
        void reason
        void wasClean
        this.disconnectSocket(socket)
    }

    webSocketError(socket: WebSocket, error: unknown): void
    {
        console.error('[AuthoritativeGameRoom] WebSocket error', error)
        this.disconnectSocket(socket)
    }

    private get room(): string
    {
        return this.ctx.id.name ?? 'public'
    }

    private ensureRuntime(): void
    {
        if(
            this.authoritativeMap !== null
            && this.authoritativeWorld !== null
            && this.simulation !== null
        )
            return

        const mapData = loadAuthoritativeMap(mapSource)
        const world = new AuthoritativeWorld({
            RAPIER,
            mapData,
        })
        const originalStep = world.step.bind(world)
        world.step = () =>
        {
            const started = performance.now()
            const result = originalStep()
            this.lastRapierStepMs = performance.now() - started
            return result
        }

        let simulation: RoomSimulation
        try
        {
            simulation = new RoomSimulation({
                world,
                mapData,
            })
        }
        catch(error)
        {
            world.destroy()
            throw error
        }

        this.authoritativeMap = mapData
        this.authoritativeWorld = world
        this.simulation = simulation
        this.currentTick = simulation.currentTick
        this.eventCursor = 0
        this.completedWorldHash = null
        this.completedWorldHashQueue.length = 0
        this.lastRapierStepMs = 0
        this.rapierInternalTimingAvailable = false
        this.runtimeGeneration++
    }

    private async createNewSession(socket: WebSocket, clientTick: number): Promise<void>
    {
        let grant: SessionGrant | null = null
        try
        {
            grant = await this.sessions.createSession({
                room: this.room,
                currentTick: this.simulation?.currentTick ?? 0,
            })
            if(grant === null)
            {
                this.rejectSocket(socket, ROOM_FULL_CODE, ROOM_FULL_MESSAGE, 1008)
                return
            }

            this.ensureRuntime()
            const reserved = this.simulation!.reserveSlot({
                playerId: grant.playerId,
            })
            if(reserved === null || reserved.entityOrder !== grant.entityOrder)
                throw new Error('session and simulation slot allocation diverged')

            socket.serializeAttachment({
                protocolVersion: 2,
                handshake: 'session_active',
                clientTick,
                playerId: grant.playerId,
                entityOrder: grant.entityOrder,
                generation: grant.generation,
            } satisfies AuthoritativeSocketAttachment)

            if(
                !this.sendSessionGrant(socket, grant)
                || !this.sendFullSync(socket)
            )
            {
                this.releaseGrant(grant)
                return
            }

            this.metrics.setSlots(this.sessions.size)
            this.scheduler.start()
        }
        catch(error)
        {
            console.error('[AuthoritativeGameRoom] Unable to create session', error)
            if(grant !== null)
                this.releaseGrant(grant)
            this.rejectSocket(
                socket,
                SESSION_FAILURE_CODE,
                SESSION_FAILURE_MESSAGE,
                1011,
            )
        }
    }

    private async resumeSession(
        socket: WebSocket,
        playerId: number,
        resumeToken: string,
    ): Promise<void>
    {
        let grant: SessionGrant | null
        try
        {
            grant = await this.sessions.resumeSession({
                room: this.room,
                playerId,
                resumeToken,
                currentTick: this.currentTick,
            })
        }
        catch(error)
        {
            console.error('[AuthoritativeGameRoom] Unable to resume session', error)
            this.rejectSocket(
                socket,
                SESSION_FAILURE_CODE,
                SESSION_FAILURE_MESSAGE,
                1011,
            )
            return
        }

        if(grant === null || this.simulation === null)
        {
            this.rejectSocket(
                socket,
                INVALID_RESUME_CODE,
                INVALID_RESUME_MESSAGE,
                1008,
            )
            return
        }

        if(!this.simulation.resume(grant.entityOrder))
        {
            this.sessions.release({
                playerId: grant.playerId,
                generation: grant.generation,
            })
            this.rejectSocket(
                socket,
                SESSION_FAILURE_CODE,
                SESSION_FAILURE_MESSAGE,
                1011,
            )
            return
        }

        socket.serializeAttachment({
            protocolVersion: 2,
            handshake: 'session_active',
            clientTick: null,
            playerId: grant.playerId,
            entityOrder: grant.entityOrder,
            generation: grant.generation,
        } satisfies AuthoritativeSocketAttachment)

        if(
            !this.sendSessionGrant(socket, grant)
            || !this.sendFullSync(socket)
        )
        {
            this.releaseGrant(grant)
            return
        }

        this.metrics.setSlots(this.sessions.size)
        this.scheduler.start()
        this.invalidateOlderConnections(socket, grant)
    }

    private sendSessionGrant(socket: WebSocket, grant: SessionGrant): boolean
    {
        try
        {
            const encodeStarted = performance.now()
            const frame = encodeResume({
                playerId: grant.playerId,
                lastServerTick: this.currentTick,
                resumeToken: resumeTokenToBytes(grant.resumeToken),
            })
            this.metrics.recordPhase('encode', performance.now() - encodeStarted)
            socket.send(frame)
            return true
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to send session grant', error)
            try
            {
                socket.close(1011, 'session grant failed')
            }
            catch
            {
                // The socket may already be closed.
            }
            return false
        }
    }

    private sendFullSync(socket: WebSocket): boolean
    {
        const simulation = this.simulation
        if(simulation === null)
            return false

        try
        {
            const snapshotStarted = performance.now()
            const fullSync = simulation.createFullSync()
            this.metrics.recordPhase('snapshot', performance.now() - snapshotStarted)

            const encodeStarted = performance.now()
            const frame = encodeFullSyncFrame(fullSync)
            this.metrics.recordPhase('encode', performance.now() - encodeStarted)
            socket.send(frame)
            return true
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to send full sync', error)
            try
            {
                socket.close(1011, 'full sync failed')
            }
            catch
            {
                // The socket may already be closed.
            }
            return false
        }
    }

    private releaseGrant(grant: SessionGrant): void
    {
        this.sessions.release({
            playerId: grant.playerId,
            generation: grant.generation,
        })

        if(this.simulation !== null)
        {
            try
            {
                this.simulation.release(grant.entityOrder)
            }
            catch(error)
            {
                console.warn('[AuthoritativeGameRoom] Unable to release simulation slot', error)
            }
        }

        this.metrics.setSlots(this.sessions.size)
        if(this.sessions.size === 0 && this.simulation !== null && !this.scheduler.running)
            this.advanceOneTick()
    }

    private invalidateOlderConnections(
        currentSocket: WebSocket,
        grant: SessionGrant,
    ): void
    {
        for(const socket of this.ctx.getWebSockets())
        {
            if(socket === currentSocket)
                continue

            const attachment = this.readAttachment(socket)
            if(
                attachment?.handshake !== 'session_active'
                || attachment.playerId !== grant.playerId
                || attachment.generation === null
                || attachment.generation >= grant.generation
            )
                continue

            this.rejectSocket(
                socket,
                STALE_CONNECTION_CODE,
                STALE_CONNECTION_MESSAGE,
                1008,
            )
        }
    }

    private disconnectSocket(socket: WebSocket): void
    {
        const attachment = this.readAttachment(socket)
        if(
            attachment?.handshake !== 'session_active'
            || attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
        )
            return

        const disconnected = this.sessions.disconnect({
            playerId: attachment.playerId,
            generation: attachment.generation,
            currentTick: this.currentTick,
        })
        if(!disconnected)
            return

        try
        {
            this.simulation?.disconnect(attachment.entityOrder)
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to disconnect simulation slot', error)
        }
        this.metrics.setSlots(this.sessions.size)
    }

    private advanceOneTick(): void
    {
        const simulation = this.simulation
        if(simulation === null)
        {
            this.scheduler.stop()
            return
        }

        this.lastRapierStepMs = 0
        const tickStarted = performance.now()
        const tick = simulation.advanceOneTick()
        const tickDurationMs = performance.now() - tickStarted
        this.currentTick = tick

        this.metrics.recordPhase('rapierStep', this.lastRapierStepMs)
        this.metrics.recordPhase(
            'controllerUpdate',
            Math.max(0, tickDurationMs - this.lastRapierStepMs),
        )
        this.recordRapierInternalTimings()

        this.sessions.expireGrace(tick)
        this.metrics.setSlots(this.sessions.size)
        this.metrics.recordQueueDepth(this.readQueueDepth())

        if(tick % WORLD_HASH_INTERVAL_TICKS === 0)
            this.captureWorldHash(tick)

        if(tick % STATE_BROADCAST_INTERVAL_TICKS === 0)
            this.broadcastState()

        const summary = this.metrics.completeTick(tick)
        if(summary !== null)
        {
            console.info('[AuthoritativeGameRoom] metrics', JSON.stringify({
                room: this.room,
                ...summary,
                rapierInternalTimingAvailable: this.rapierInternalTimingAvailable,
            }))
        }

        if(this.sessions.size === 0)
            this.shutdownRuntime()
    }

    private captureWorldHash(hashTick: number): void
    {
        const world = this.authoritativeWorld
        if(world === null)
            return

        const snapshotStarted = performance.now()
        const snapshot = Uint8Array.from(world.takeSnapshot())
        this.metrics.recordPhase('snapshot', performance.now() - snapshotStarted)

        const generation = this.runtimeGeneration
        const hashing = hashWorldSnapshot(snapshot)
            .then((sha256) =>
            {
                if(generation !== this.runtimeGeneration || this.simulation === null)
                    return

                this.completedWorldHashQueue.push({
                    hashTick,
                    sha256,
                })
                this.completedWorldHashQueue.sort((left, right) =>
                    left.hashTick - right.hashTick)
                this.promoteCompletedWorldHash()
            })
            .catch((error: unknown) =>
            {
                console.error('[AuthoritativeGameRoom] World hash failed', error)
            })

        this.ctx.waitUntil(hashing)
    }

    private promoteCompletedWorldHash(): void
    {
        if(this.completedWorldHash === null)
            this.completedWorldHash = this.completedWorldHashQueue.shift() ?? null
    }

    private broadcastState(): void
    {
        const simulation = this.simulation
        if(simulation === null)
            return

        const sockets = this.currentControllerSockets()
        if(sockets.length === 0)
            return

        const checksumStarted = performance.now()
        const state = simulation.readStateFrame(this.eventCursor)
        this.metrics.recordPhase('checksum', performance.now() - checksumStarted)

        const worldHash = this.completedWorldHash
        const encodeStarted = performance.now()
        const frame = encodeStateFrame({
            ...state,
            worldHash,
        })
        this.metrics.recordPhase('encode', performance.now() - encodeStarted)

        const broadcastStarted = performance.now()
        for(const socket of sockets)
        {
            try
            {
                socket.send(frame)
            }
            catch(error)
            {
                console.warn('[AuthoritativeGameRoom] State broadcast failed', error)
            }
        }
        this.metrics.recordPhase('broadcast', performance.now() - broadcastStarted)

        this.eventCursor = state.eventCursor
        if(worldHash !== null)
        {
            this.completedWorldHash = null
            this.promoteCompletedWorldHash()
        }
    }

    private currentControllerSockets(): WebSocket[]
    {
        return this.ctx.getWebSockets().filter((socket) =>
        {
            const attachment = this.readAttachment(socket)
            return attachment?.handshake === 'session_active'
                && attachment.playerId !== null
                && attachment.generation !== null
                && this.sessions.isCurrentController(
                    attachment.playerId,
                    attachment.generation,
                )
        })
    }

    private readQueueDepth(): number
    {
        const slots = (this.simulation as unknown as { slots?: QueueSlot[] } | null)?.slots
        if(!Array.isArray(slots))
            return 0

        return slots.reduce((total, slot) =>
            total + (slot?.queuedInputs?.size ?? 0), 0)
    }

    private recordRapierInternalTimings(): void
    {
        const world = this.authoritativeWorld?.world as Record<string, unknown> | undefined
        if(world === undefined)
            return

        for(const [ phase, methodName ] of Object.entries(RAPIER_TIMING_METHODS))
        {
            const method = world[methodName]
            if(typeof method !== 'function')
                continue

            try
            {
                const milliseconds = Number(method.call(world))
                if(Number.isFinite(milliseconds) && milliseconds >= 0)
                {
                    this.metrics.recordPhase(phase, milliseconds)
                    this.rapierInternalTimingAvailable = true
                }
            }
            catch(error)
            {
                console.warn(`[AuthoritativeGameRoom] ${methodName} failed`, error)
            }
        }
    }

    private shutdownRuntime(): void
    {
        this.scheduler.stop()
        this.runtimeGeneration++
        this.authoritativeWorld?.destroy()
        this.authoritativeMap = null
        this.authoritativeWorld = null
        this.simulation = null
        this.currentTick = 0
        this.eventCursor = 0
        this.lastRapierStepMs = 0
        this.completedWorldHash = null
        this.completedWorldHashQueue.length = 0
        this.rapierInternalTimingAvailable = false
        this.metrics.reset()
    }

    private getAttachment(socket: WebSocket): AuthoritativeSocketAttachment
    {
        const attachment = this.readAttachment(socket)
        if(attachment !== null)
            return attachment

        const fallback = createAttachment()
        socket.serializeAttachment(fallback)
        return fallback
    }

    private readAttachment(socket: WebSocket): AuthoritativeSocketAttachment | null
    {
        const attachment = socket.deserializeAttachment() as AuthoritativeSocketAttachment | null
        if(attachment?.protocolVersion !== 2)
            return null

        if(
            attachment.handshake === 'awaiting_handshake'
            || attachment.handshake === 'processing_handshake'
        )
        {
            return attachment.playerId === null
                && attachment.entityOrder === null
                && attachment.generation === null
                ? attachment
                : null
        }

        if(
            attachment.handshake === 'session_active'
            && isUint32(attachment.playerId)
            && attachment.playerId > 0
            && isEntityOrder(attachment.entityOrder)
            && isUint32(attachment.generation)
            && attachment.generation > 0
            && (attachment.clientTick === null || isUint32(attachment.clientTick))
        )
            return attachment

        return null
    }

    private rejectSocket(
        socket: WebSocket,
        code: number,
        message: string,
        closeCode: number,
    ): void
    {
        try
        {
            socket.send(encodeErrorFrame({
                code,
                retryable: false,
                contextTick: this.currentTick,
                message,
            }))
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to send protocol error', error)
        }

        try
        {
            socket.close(closeCode, message.toLowerCase().replaceAll('_', ' '))
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to close rejected socket', error)
        }
    }
}
