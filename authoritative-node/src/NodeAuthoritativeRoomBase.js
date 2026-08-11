import { performance } from 'node:perf_hooks'
import mapSource from '../../packages/authoritative-physics/generated/map-v1.json' with { type: 'json' }
import RAPIER from '@dimforge/rapier3d'
import {
    AuthoritativeWorld,
    BENCHMARK_FRAME_TYPES,
    FRAME_TYPES,
    LIFECYCLE_FRAME_TYPES,
    RAPIER_VERSION,
    ROOM_SLOT_STATES,
    RoomSimulation,
    VERSIONS,
    decodeBenchmarkSummaryRequest,
    decodeFullSyncRequest,
    decodeHello,
    decodeInputBatch,
    decodeResume,
    decodeSyncReady,
    digestBenchmarkToken,
    encodeBenchmarkSummary,
    encodeErrorFrame,
    encodeFullSyncFrame,
    encodeResume,
    encodeStateFrame,
    hashWorldSnapshot,
    loadAuthoritativeMap,
} from '@ch-folio/authoritative-physics'
import { WebSocket } from 'ws'
import { Metrics } from './Metrics.js'
import { SessionRegistry, SESSION_STATES } from './SessionRegistry.js'
import { TickScheduler } from './TickScheduler.js'
import {
    constantTimeEqual,
    resumeTokenFromBytes,
    resumeTokenToBytes,
} from './token.js'

const ERROR_CODES = Object.freeze({
    HELLO_REQUIRED: 1,
    INVALID_HANDSHAKE: 2,
    UNEXPECTED_FRAME: 3,
    ROOM_FULL: 4,
    INVALID_RESUME: 5,
    STALE_CONNECTION: 6,
    SESSION_FAILURE: 7,
    BENCHMARK_UNAVAILABLE: 8,
})

const STATE_BROADCAST_INTERVAL_TICKS = 3
const WORLD_HASH_INTERVAL_TICKS = 60
const MIN_BENCHMARK_TOKEN_LENGTH = 32

function createAttachment()
{
    return {
        handshake: 'awaiting_handshake',
        clientTick: null,
        playerId: null,
        entityOrder: null,
        generation: null,
    }
}

function binaryBytes(value)
{
    if(value instanceof Uint8Array)
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)
    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError('protocol-v2 messages must be binary')
}

export class NodeAuthoritativeRoom
{
    constructor({
        room,
        onEmpty = () => {},
        clock,
        autoSchedule = true,
        benchmarkToken = null,
    } = {})
    {
        if(typeof room !== 'string' || room.length < 1)
            throw new TypeError('room must be a non-empty string')
        if(typeof onEmpty !== 'function')
            throw new TypeError('onEmpty must be a function')
        if(
            benchmarkToken !== null
            && (typeof benchmarkToken !== 'string' || benchmarkToken.length < MIN_BENCHMARK_TOKEN_LENGTH)
        )
            throw new RangeError(`benchmarkToken must contain at least ${MIN_BENCHMARK_TOKEN_LENGTH} characters`)

        this.room = room
        this.onEmpty = onEmpty
        this.autoSchedule = autoSchedule
        this.sessions = new SessionRegistry()
        this.metrics = new Metrics()
        this.benchmarkTokenDigest = benchmarkToken === null
            ? null
            : digestBenchmarkToken(benchmarkToken)
        this.sockets = new Set()
        this.attachments = new Map()
        this.authoritativeMap = null
        this.authoritativeWorld = null
        this.simulation = null
        this.currentTick = 0
        this.eventCursor = 0
        this.runtimeGeneration = 0
        this.completedWorldHashes = []
        this.pendingHashes = new Set()
        this.messageChain = Promise.resolve()
        this.destroyed = false
        this.scheduler = new TickScheduler({
            clock,
            onTick: () => this.advanceOneTick(),
            onCallback: (dueTicks, executedTicks) =>
                this.metrics.recordSchedulerCallback(dueTicks, executedTicks),
        })
    }

    get isEmpty()
    {
        return this.sessions.size === 0 && this.sockets.size === 0
    }

    get activeSocketCount()
    {
        return this.sockets.size
    }

    summary()
    {
        return {
            room: this.room,
            currentTick: this.currentTick,
            sessionCount: this.sessions.size,
            activeSocketCount: this.sockets.size,
            schedulerRunning: this.scheduler.running,
            runtimeLoaded: this.simulation !== null,
        }
    }

    attachSocket(socket)
    {
        if(this.destroyed)
        {
            socket.close(1012, 'room_destroyed')
            return false
        }

        const attachment = createAttachment()
        this.sockets.add(socket)
        this.attachments.set(socket, attachment)
        socket.on('message', (data, isBinary) =>
        {
            const task = this.messageChain.then(() => this.handleMessage(socket, data, isBinary))
            this.messageChain = task.catch((error) =>
            {
                console.error('[authoritative-node] message handling failed', error)
                this.rejectSocket(socket, ERROR_CODES.SESSION_FAILURE, 'SESSION_FAILURE', 1011, false)
            })
        })
        socket.once('close', () => this.handleClose(socket))
        socket.once('error', () => this.handleClose(socket))

        this.sendError(socket, ERROR_CODES.HELLO_REQUIRED, 'HELLO_REQUIRED', true)
        return true
    }

    flushMessages()
    {
        return this.messageChain
    }

    ensureRuntime()
    {
        if(this.simulation !== null)
            return

        const mapData = loadAuthoritativeMap(mapSource)
        const world = new AuthoritativeWorld({ RAPIER, mapData })
        let simulation
        try
        {
            simulation = new RoomSimulation({ world, mapData })
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
        this.completedWorldHashes.length = 0
        this.runtimeGeneration++
    }

    async handleMessage(socket, data, isBinary)
    {
        const attachment = this.attachments.get(socket)
        if(attachment === undefined || this.destroyed)
            return

        if(!isBinary)
        {
            const message = attachment.handshake === 'session_active'
                ? 'INVALID_FRAME'
                : 'INVALID_HANDSHAKE'
            this.rejectSocket(socket, ERROR_CODES.INVALID_HANDSHAKE, message, 1003)
            return
        }

        const bytes = binaryBytes(data)
        if(attachment.handshake === 'processing_handshake')
        {
            this.rejectSocket(socket, ERROR_CODES.UNEXPECTED_FRAME, 'UNEXPECTED_FRAME', 1008)
            return
        }

        if(attachment.handshake === 'session_active')
        {
            await this.handleActiveFrame(socket, attachment, bytes)
            return
        }

        attachment.handshake = 'processing_handshake'
        try
        {
            try
            {
                const hello = decodeHello(bytes)
                attachment.clientTick = hello.clientTick
                await this.createNewSession(socket, attachment, hello.clientTick)
                return
            }
            catch
            {
                // The first binary frame may be RESUME instead of HELLO.
            }

            try
            {
                const resume = decodeResume(bytes)
                await this.resumeSession(socket, attachment, resume)
            }
            catch
            {
                this.rejectSocket(socket, ERROR_CODES.INVALID_HANDSHAKE, 'INVALID_HANDSHAKE', 1002)
            }
        }
        catch(error)
        {
            console.error('[authoritative-node] handshake failure', error)
            this.rejectSocket(socket, ERROR_CODES.SESSION_FAILURE, 'SESSION_FAILURE', 1011)
        }
    }

    async createNewSession(socket, attachment, clientTick)
    {
        this.ensureRuntime()
        const grant = await this.sessions.createSession({
            room: this.room,
            currentTick: this.currentTick,
        })
        if(grant === null)
        {
            this.rejectSocket(socket, ERROR_CODES.ROOM_FULL, 'ROOM_FULL', 1008)
            return
        }

        const reserved = this.simulation.reserveSlot({ playerId: grant.playerId })
        if(reserved === null || reserved.entityOrder !== grant.entityOrder)
        {
            this.sessions.release({ playerId: grant.playerId, generation: grant.generation })
            throw new Error('session and simulation slot allocation diverged')
        }

        Object.assign(attachment, {
            handshake: 'session_active',
            clientTick,
            playerId: grant.playerId,
            entityOrder: grant.entityOrder,
            generation: grant.generation,
        })

        if(!this.sendSessionGrant(socket, grant) || !this.sendFullSync(socket))
            return
        if(this.autoSchedule)
            this.scheduler.start()
    }

    async resumeSession(socket, attachment, resume)
    {
        if(this.simulation === null)
        {
            this.rejectSocket(socket, ERROR_CODES.INVALID_RESUME, 'INVALID_RESUME', 1008)
            return
        }

        const grant = await this.sessions.resumeSession({
            room: this.room,
            playerId: resume.playerId,
            resumeToken: resumeTokenFromBytes(resume.resumeToken),
            currentTick: this.currentTick,
        })
        if(grant === null || !this.simulation.resume(grant.entityOrder))
        {
            this.rejectSocket(socket, ERROR_CODES.INVALID_RESUME, 'INVALID_RESUME', 1008)
            return
        }

        Object.assign(attachment, {
            handshake: 'session_active',
            clientTick: resume.lastServerTick,
            playerId: grant.playerId,
            entityOrder: grant.entityOrder,
            generation: grant.generation,
        })
        if(!this.sendSessionGrant(socket, grant) || !this.sendFullSync(socket))
            return
        if(this.autoSchedule)
            this.scheduler.start()
    }

    async handleActiveFrame(socket, attachment, bytes)
    {
        if(
            attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
            || !this.sessions.isCurrentController(attachment.playerId, attachment.generation)
        )
        {
            this.rejectSocket(socket, ERROR_CODES.STALE_CONNECTION, 'STALE_CONNECTION', 1008)
            return
        }

        try
        {
            const frameType = bytes[0]
            if(frameType === LIFECYCLE_FRAME_TYPES.SYNC_READY)
            {
                decodeSyncReady(bytes)
                this.acceptSyncReady(attachment)
                return
            }
            if(frameType === FRAME_TYPES.INPUT_BATCH)
            {
                this.acceptInputs(attachment, decodeInputBatch(bytes))
                return
            }
            if(frameType === LIFECYCLE_FRAME_TYPES.FULL_SYNC_REQUEST)
            {
                decodeFullSyncRequest(bytes)
                this.sendFullSync(socket)
                return
            }
            if(frameType === BENCHMARK_FRAME_TYPES.SUMMARY_REQUEST)
            {
                await this.acceptBenchmarkSummary(socket, bytes)
                return
            }
            this.rejectSocket(socket, ERROR_CODES.UNEXPECTED_FRAME, 'UNEXPECTED_FRAME', 1008)
        }
        catch(error)
        {
            console.warn('[authoritative-node] invalid active frame', error)
            this.rejectSocket(socket, ERROR_CODES.INVALID_HANDSHAKE, 'INVALID_FRAME', 1002)
        }
    }

    async acceptBenchmarkSummary(socket, bytes)
    {
        const request = decodeBenchmarkSummaryRequest(bytes)
        const expected = this.benchmarkTokenDigest === null
            ? null
            : await this.benchmarkTokenDigest
        if(expected === null || !constantTimeEqual(expected, request.tokenDigest))
        {
            this.rejectSocket(
                socket,
                ERROR_CODES.BENCHMARK_UNAVAILABLE,
                'BENCHMARK_UNAVAILABLE',
                1008,
            )
            return
        }

        const summary = {
            schemaVersion: 1,
            mode: 'node',
            room: this.room,
            currentTick: this.currentTick,
            runtimeStarts: 1,
            roomRestarts: 0,
            rapierVersion: RAPIER_VERSION,
            versions: VERSIONS,
            rapierInternalTimingAvailable: false,
            observedPeakMemoryBytes: process.memoryUsage.rss(),
            memoryScope: 'node-process-rss',
            metrics: this.metrics.readBenchmarkSummary(),
        }
        this.safeSend(socket, encodeBenchmarkSummary(summary))
    }

    acceptSyncReady(attachment)
    {
        const slot = this.simulation.getSlot(attachment.entityOrder)
        if(slot.slotState === ROOM_SLOT_STATES.SYNCING)
            this.simulation.markSyncReady(attachment.entityOrder)
        else if(
            slot.slotState !== ROOM_SLOT_STATES.WAITING_SPAWN
            && slot.slotState !== ROOM_SLOT_STATES.ACTIVE
        )
            throw new Error('session cannot become sync-ready from its current state')

        this.sessions.setState({
            playerId: attachment.playerId,
            generation: attachment.generation,
            state: slot.slotState === ROOM_SLOT_STATES.ACTIVE
                ? SESSION_STATES.ACTIVE
                : SESSION_STATES.WAITING_SPAWN,
        })
    }

    acceptInputs(attachment, inputs)
    {
        const slot = this.simulation.getSlot(attachment.entityOrder)
        for(const input of inputs)
            this.simulation.queueInput(attachment.entityOrder, input)
        if(slot.slotState === ROOM_SLOT_STATES.ACTIVE)
        {
            this.sessions.setState({
                playerId: attachment.playerId,
                generation: attachment.generation,
                state: SESSION_STATES.ACTIVE,
            })
        }
    }

    readQueueDepth()
    {
        if(this.simulation === null)
            return 0
        return this.simulation.slots.reduce((maximum, slot) =>
            Math.max(maximum, slot?.queuedInputs?.size ?? 0), 0)
    }

    advanceOneTick()
    {
        if(this.simulation === null || this.destroyed)
            return this.currentTick
        if(this.benchmarkTokenDigest !== null)
            return this.advanceOneTickWithBenchmarkPhases()

        const started = performance.now()
        this.currentTick = this.simulation.advanceOneTick()
        const completedTick = this.currentTick
        this.syncActiveSessionStates()
        this.sessions.expireGrace(this.currentTick)

        if(this.currentTick % WORLD_HASH_INTERVAL_TICKS === 0)
            this.captureWorldHash()
        if(this.currentTick % STATE_BROADCAST_INTERVAL_TICKS === 0)
            this.broadcastState()

        this.cleanupIfEmpty()
        this.metrics.recordPhase('totalTick', performance.now() - started)
        this.metrics.recordQueueDepth(this.readQueueDepth())
        this.metrics.setSlots(this.sessions.size)
        this.metrics.completeTick(completedTick)
        return this.currentTick
    }

    advanceOneTickWithBenchmarkPhases()
    {
        const started = performance.now()

        let phaseStarted = performance.now()
        this.currentTick = this.simulation.advanceOneTick()
        this.metrics.recordPhase('simulationAdvance', performance.now() - phaseStarted)
        const completedTick = this.currentTick

        phaseStarted = performance.now()
        this.syncActiveSessionStates()
        this.metrics.recordPhase('sessionSync', performance.now() - phaseStarted)

        phaseStarted = performance.now()
        this.sessions.expireGrace(this.currentTick)
        this.metrics.recordPhase('graceExpiry', performance.now() - phaseStarted)

        phaseStarted = performance.now()
        if(this.currentTick % WORLD_HASH_INTERVAL_TICKS === 0)
            this.captureWorldHash()
        this.metrics.recordPhase('worldHashCapture', performance.now() - phaseStarted)

        phaseStarted = performance.now()
        if(this.currentTick % STATE_BROADCAST_INTERVAL_TICKS === 0)
            this.broadcastState()
        this.metrics.recordPhase('stateBroadcast', performance.now() - phaseStarted)

        phaseStarted = performance.now()
        this.cleanupIfEmpty()
        this.metrics.recordPhase('cleanup', performance.now() - phaseStarted)

        this.metrics.recordPhase('totalTick', performance.now() - started)

        phaseStarted = performance.now()
        this.metrics.recordQueueDepth(this.readQueueDepth())
        this.metrics.setSlots(this.sessions.size)
        this.metrics.recordPhase('queueBookkeeping', performance.now() - phaseStarted)
        this.metrics.completeTick(completedTick)
        return this.currentTick
    }

    syncActiveSessionStates()
    {
        for(const slot of this.simulation.slots)
        {
            if(!slot || slot.slotState !== ROOM_SLOT_STATES.ACTIVE)
                continue
            const session = this.sessions.readSession(slot.playerId)
            if(session?.controllerActive && session.state !== SESSION_STATES.ACTIVE)
            {
                this.sessions.setState({
                    playerId: session.playerId,
                    generation: session.generation,
                    state: SESSION_STATES.ACTIVE,
                })
            }
        }
    }

    captureWorldHash()
    {
        const generation = this.runtimeGeneration
        const hashTick = this.currentTick
        const snapshot = Uint8Array.from(this.authoritativeWorld.takeSnapshot())
        const pending = hashWorldSnapshot(snapshot)
            .then((sha256) =>
            {
                if(!this.destroyed && generation === this.runtimeGeneration)
                {
                    this.completedWorldHashes.push({ hashTick, sha256 })
                    this.completedWorldHashes.sort((left, right) => left.hashTick - right.hashTick)
                }
            })
            .finally(() => this.pendingHashes.delete(pending))
        this.pendingHashes.add(pending)
    }

    broadcastState()
    {
        const state = this.simulation.readStateFrame(this.eventCursor)
        const completed = this.completedWorldHashes.shift() ?? null
        state.worldHash = completed
        const frame = encodeStateFrame(state)
        this.eventCursor = state.eventCursor

        for(const socket of this.sockets)
        {
            const attachment = this.attachments.get(socket)
            if(
                attachment?.handshake === 'session_active'
                && attachment.playerId !== null
                && attachment.generation !== null
                && this.sessions.isCurrentController(attachment.playerId, attachment.generation)
            )
                this.safeSend(socket, frame)
        }
    }

    sendSessionGrant(socket, grant)
    {
        return this.safeSend(socket, encodeResume({
            playerId: grant.playerId,
            lastServerTick: this.currentTick,
            resumeToken: resumeTokenToBytes(grant.resumeToken),
        }))
    }

    sendFullSync(socket)
    {
        if(this.simulation === null)
            return false
        return this.safeSend(socket, encodeFullSyncFrame(this.simulation.createFullSync()))
    }

    sendError(socket, code, message, retryable = false)
    {
        return this.safeSend(socket, encodeErrorFrame({
            code,
            retryable,
            contextTick: this.currentTick,
            message,
        }))
    }

    safeSend(socket, frame)
    {
        if(socket.readyState !== WebSocket.OPEN)
            return false
        try
        {
            socket.send(frame)
            return true
        }
        catch
        {
            return false
        }
    }

    rejectSocket(socket, code, message, closeCode, retryable = false)
    {
        this.sendError(socket, code, message, retryable)
        try
        {
            if(socket.readyState < WebSocket.CLOSING)
                socket.close(closeCode, message.toLowerCase())
        }
        catch
        {
            socket.terminate()
        }
    }

    handleClose(socket)
    {
        const attachment = this.attachments.get(socket)
        if(attachment === undefined)
            return

        this.attachments.delete(socket)
        this.sockets.delete(socket)
        if(
            attachment.handshake === 'session_active'
            && attachment.playerId !== null
            && attachment.entityOrder !== null
            && attachment.generation !== null
            && this.sessions.disconnect({
                playerId: attachment.playerId,
                generation: attachment.generation,
                currentTick: this.currentTick,
            })
        )
        {
            this.metrics.recordDisconnect()
            this.simulation?.disconnect(attachment.entityOrder)
        }

        this.cleanupIfEmpty()
    }

    cleanupIfEmpty()
    {
        if(this.sessions.size !== 0)
            return false

        this.scheduler.stop()
        this.destroyRuntime()
        if(this.sockets.size === 0)
            this.onEmpty(this)
        return true
    }

    destroyRuntime()
    {
        this.runtimeGeneration++
        this.completedWorldHashes.length = 0
        this.authoritativeWorld?.destroy()
        this.authoritativeMap = null
        this.authoritativeWorld = null
        this.simulation = null
        this.currentTick = 0
        this.eventCursor = 0
    }

    async destroy()
    {
        if(this.destroyed)
            return
        this.destroyed = true
        this.scheduler.stop()
        for(const socket of this.sockets)
        {
            try
            {
                socket.close(1001, 'server_shutdown')
                socket.terminate()
            }
            catch
            {
                // Socket is already closed.
            }
        }
        this.sockets.clear()
        this.attachments.clear()
        this.sessions.clear()
        this.destroyRuntime()
        await Promise.allSettled(Array.from(this.pendingHashes))
    }
}
