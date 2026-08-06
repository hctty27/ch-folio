import {
    BENCHMARK_FRAME_TYPES,
    FRAME_TYPES,
    LIFECYCLE_FRAME_TYPES,
    RAPIER_VERSION,
    ROOM_SLOT_STATES,
    VERSIONS,
    decodeBenchmarkSummaryRequest,
    decodeFullSyncRequest,
    decodeInputBatch,
    decodeSyncReady,
    digestBenchmarkToken,
    encodeBenchmarkSummary,
} from '@ch-folio/authoritative-physics'
import { AuthoritativeGameRoom as BaseAuthoritativeGameRoom } from './AuthoritativeGameRoom'
import { constantTimeEqual } from './crypto'
import { Metrics } from './Metrics'
import { SESSION_STATES } from './SessionRegistry'

const INVALID_FRAME_CODE = 2
const UNEXPECTED_FRAME_CODE = 3
const STALE_CONNECTION_CODE = 6
const BENCHMARK_UNAVAILABLE_CODE = 8
const INVALID_FRAME_MESSAGE = 'INVALID_FRAME'
const UNEXPECTED_FRAME_MESSAGE = 'UNEXPECTED_FRAME'
const STALE_CONNECTION_MESSAGE = 'STALE_CONNECTION'
const BENCHMARK_UNAVAILABLE_MESSAGE = 'BENCHMARK_UNAVAILABLE'

const MIN_BENCHMARK_TOKEN_LENGTH = 32

type ActiveAttachment = {
    protocolVersion: 2
    handshake: 'awaiting_handshake' | 'processing_handshake' | 'session_active'
    clientTick: number | null
    playerId: number | null
    entityOrder: number | null
    generation: number | null
}

type SimulationSlot = {
    slotState: number
    hasBody: boolean
    queuedInputs?: Map<number, unknown>
}

type RuntimeAccess = {
    currentTick: number
    runtimeGeneration: number
    rapierInternalTimingAvailable: boolean
    metrics: Metrics
    advanceOneTick(): void
    readQueueDepth(): number
    getAttachment(socket: WebSocket): ActiveAttachment
    rejectSocket(socket: WebSocket, code: number, message: string, closeCode: number): void
    sendFullSync(socket: WebSocket): boolean
    sessions: {
        isCurrentController(playerId: number, generation: number): boolean
        setState(options: {
            playerId: number
            generation: number
            state: 'syncing' | 'waiting_spawn' | 'active'
        }): boolean
    }
    simulation: {
        slots?: Array<SimulationSlot | null>
        getSlot(entityOrder: number): SimulationSlot
        markSyncReady(entityOrder: number): unknown
        queueInput(entityOrder: number, input: unknown): boolean
    } | null
}

type BenchmarkEnv = Env & {
    AUTHORITATIVE_BENCHMARK_TOKEN?: unknown
}

export class AuthoritativeGameRoom extends BaseAuthoritativeGameRoom
{
    private readonly benchmarkTokenDigest: Promise<Uint8Array> | null
    private readonly disconnectedSockets = new WeakSet<WebSocket>()

    constructor(ctx: DurableObjectState, env: Env)
    {
        super(ctx, env)
        const token = (env as BenchmarkEnv).AUTHORITATIVE_BENCHMARK_TOKEN
        this.benchmarkTokenDigest = typeof token === 'string'
            && token.length >= MIN_BENCHMARK_TOKEN_LENGTH
            ? digestBenchmarkToken(token)
            : null
        this.installBenchmarkRuntimeHooks()
    }

    override async webSocketMessage(
        socket: WebSocket,
        message: string | ArrayBuffer,
    ): Promise<void>
    {
        const runtime = this as unknown as RuntimeAccess
        const attachment = runtime.getAttachment(socket)

        if(attachment.handshake !== 'session_active')
        {
            await super.webSocketMessage(socket, message)
            return
        }

        if(
            attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
            || !runtime.sessions.isCurrentController(
                attachment.playerId,
                attachment.generation,
            )
        )
        {
            runtime.rejectSocket(
                socket,
                STALE_CONNECTION_CODE,
                STALE_CONNECTION_MESSAGE,
                1008,
            )
            return
        }

        if(typeof message === 'string')
        {
            runtime.rejectSocket(
                socket,
                INVALID_FRAME_CODE,
                INVALID_FRAME_MESSAGE,
                1003,
            )
            return
        }

        try
        {
            const frameType = new Uint8Array(message)[0]
            if(frameType === LIFECYCLE_FRAME_TYPES.SYNC_READY)
            {
                decodeSyncReady(message)
                this.acceptSyncReady(runtime, attachment)
                return
            }

            if(frameType === FRAME_TYPES.INPUT_BATCH)
            {
                const inputs = decodeInputBatch(message)
                this.acceptInputs(runtime, attachment, inputs)
                return
            }

            if(frameType === LIFECYCLE_FRAME_TYPES.FULL_SYNC_REQUEST)
            {
                decodeFullSyncRequest(message)
                if(!runtime.sendFullSync(socket))
                    throw new Error('unable to send full sync')
                return
            }

            if(frameType === BENCHMARK_FRAME_TYPES.SUMMARY_REQUEST)
            {
                await this.acceptBenchmarkSummary(runtime, socket, message)
                return
            }

            runtime.rejectSocket(
                socket,
                UNEXPECTED_FRAME_CODE,
                UNEXPECTED_FRAME_MESSAGE,
                1008,
            )
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Invalid active-session frame', error)
            runtime.rejectSocket(
                socket,
                INVALID_FRAME_CODE,
                INVALID_FRAME_MESSAGE,
                1002,
            )
        }
    }

    override webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
    ): void
    {
        this.recordDisconnect(socket)
        super.webSocketClose(socket, code, reason, wasClean)
    }

    override webSocketError(socket: WebSocket, error: unknown): void
    {
        this.recordDisconnect(socket)
        super.webSocketError(socket, error)
    }

    private installBenchmarkRuntimeHooks(): void
    {
        const runtime = this as unknown as RuntimeAccess
        const advanceOneTick = runtime.advanceOneTick.bind(this)
        runtime.advanceOneTick = (): void =>
        {
            const previousTick = runtime.currentTick
            const started = performance.now()
            advanceOneTick()
            if(runtime.currentTick > previousTick)
            {
                runtime.metrics.recordCompletedTickPhase(
                    'totalTick',
                    performance.now() - started,
                )
            }
        }

        runtime.readQueueDepth = (): number =>
        {
            const slots = runtime.simulation?.slots
            if(!Array.isArray(slots))
                return 0
            return slots.reduce((maximum, slot) =>
                Math.max(maximum, slot?.queuedInputs?.size ?? 0), 0)
        }
    }

    private recordDisconnect(socket: WebSocket): void
    {
        if(this.disconnectedSockets.has(socket))
            return
        this.disconnectedSockets.add(socket)
        ;(this as unknown as RuntimeAccess).metrics.recordDisconnect()
    }

    private async acceptBenchmarkSummary(
        runtime: RuntimeAccess,
        socket: WebSocket,
        message: ArrayBuffer,
    ): Promise<void>
    {
        const request = decodeBenchmarkSummaryRequest(message)
        const expected = this.benchmarkTokenDigest === null
            ? null
            : await this.benchmarkTokenDigest
        if(expected === null || !constantTimeEqual(expected, request.tokenDigest))
        {
            runtime.rejectSocket(
                socket,
                BENCHMARK_UNAVAILABLE_CODE,
                BENCHMARK_UNAVAILABLE_MESSAGE,
                1008,
            )
            return
        }

        const runtimeStarts = Math.ceil(runtime.runtimeGeneration / 2)
        const summary = {
            schemaVersion: 1,
            mode: 'durable-object',
            room: this.ctx.id.name ?? 'public',
            currentTick: runtime.currentTick,
            runtimeStarts,
            roomRestarts: Math.max(0, runtimeStarts - 1),
            rapierVersion: RAPIER_VERSION,
            versions: VERSIONS,
            rapierInternalTimingAvailable: runtime.rapierInternalTimingAvailable,
            observedPeakMemoryBytes: null,
            memoryScope: 'cloudflare-v8-isolate-observation-required',
            metrics: runtime.metrics.readBenchmarkSummary(),
        }

        const encodeStarted = performance.now()
        const frame = encodeBenchmarkSummary(summary)
        runtime.metrics.recordPhase('encode', performance.now() - encodeStarted)
        socket.send(frame)
    }

    private acceptSyncReady(
        runtime: RuntimeAccess,
        attachment: ActiveAttachment,
    ): void
    {
        const simulation = runtime.simulation
        if(
            simulation === null
            || attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
        )
            throw new Error('active session has no simulation slot')

        const slot = simulation.getSlot(attachment.entityOrder)
        if(slot.slotState === ROOM_SLOT_STATES.SYNCING)
            simulation.markSyncReady(attachment.entityOrder)
        else if(
            slot.slotState !== ROOM_SLOT_STATES.WAITING_SPAWN
            && slot.slotState !== ROOM_SLOT_STATES.ACTIVE
        )
            throw new Error('session cannot become sync-ready from its current state')

        runtime.sessions.setState({
            playerId: attachment.playerId,
            generation: attachment.generation,
            state: slot.slotState === ROOM_SLOT_STATES.ACTIVE
                ? SESSION_STATES.ACTIVE
                : SESSION_STATES.WAITING_SPAWN,
        })
    }

    private acceptInputs(
        runtime: RuntimeAccess,
        attachment: ActiveAttachment,
        inputs: ReturnType<typeof decodeInputBatch>,
    ): void
    {
        const simulation = runtime.simulation
        if(
            simulation === null
            || attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
        )
            throw new Error('active session has no simulation slot')

        const slot = simulation.getSlot(attachment.entityOrder)
        for(const input of inputs)
            simulation.queueInput(attachment.entityOrder, input)

        if(slot.slotState === ROOM_SLOT_STATES.ACTIVE)
        {
            runtime.sessions.setState({
                playerId: attachment.playerId,
                generation: attachment.generation,
                state: SESSION_STATES.ACTIVE,
            })
        }
    }
}
