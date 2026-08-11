import { performance } from 'node:perf_hooks'

import {
    BENCHMARK_FRAME_TYPES,
    FRAME_TYPES,
    INPUT_BUFFER_TICKS,
    checksum32,
    decodeBenchmarkSummary,
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeResume,
    decodeStateFrame,
    digestBenchmarkToken,
    encodeBenchmarkSummaryRequest,
    encodeHello,
    encodeInputBatch,
    encodeSyncReady,
} from '@ch-folio/authoritative-physics'
import {
    FrameRouter,
    buildNodeBenchmarkWebSocketUrl,
} from './loadtest-authoritative-node-base.mjs'

const TICK_RATE_HZ = 60
const STATE_INTERVAL_TICKS = 3
const INITIAL_PREDICTION_LEAD_TICKS = 8
export const NETWORK_WARMUP_TICKS = 600
const NETWORK_WARMUP_SECONDS = NETWORK_WARMUP_TICKS / TICK_RATE_HZ

function uint32(value)
{
    return Number(value) >>> 0
}

function tickAdd(tick, delta)
{
    return (uint32(tick) + Number(delta)) >>> 0
}

function tickDelta(left, right)
{
    return (uint32(left) - uint32(right)) | 0
}

function tickAfter(left, right)
{
    return tickDelta(left, right) > 0
}

function binaryBytes(value)
{
    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)
    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError('benchmark WebSocket received non-binary data')
}

function waitForOpen(socket, timeoutMs = 5000)
{
    return new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(
            () => reject(new Error('timed out opening benchmark WebSocket')),
            timeoutMs,
        )
        socket.addEventListener('open', () =>
        {
            clearTimeout(timeout)
            resolve()
        }, { once: true })
        socket.addEventListener('error', () =>
        {
            clearTimeout(timeout)
            reject(new Error('benchmark WebSocket failed to open'))
        }, { once: true })
    })
}

function waitUntil(predicate, timeoutMs, label)
{
    const started = performance.now()
    return new Promise((resolve, reject) =>
    {
        const poll = () =>
        {
            if(predicate())
            {
                resolve()
                return
            }
            if(performance.now() - started >= timeoutMs)
            {
                reject(new Error(`timed out waiting for ${label}`))
                return
            }
            setTimeout(poll, 10)
        }
        poll()
    })
}

function sleep(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function nextBenchmarkPredictionTick(serverTick, previousPredictionTick)
{
    const desired = tickAdd(serverTick, INITIAL_PREDICTION_LEAD_TICKS)
    if(previousPredictionTick === null || previousPredictionTick === undefined)
        return desired

    const next = tickAdd(previousPredictionTick, 1)
    return tickAfter(desired, next) ? desired : next
}

export function commandTickForBenchmarkPrediction(predictionTick)
{
    return tickAdd(predictionTick, -INPUT_BUFFER_TICKS)
}

function createQuantizedInput(commandTick, sequence, scheduleTick, clientIndex)
{
    const steeringPhase = (Math.floor(scheduleTick / 120) + clientIndex) % 4
    return {
        clientTick: uint32(commandTick),
        sequence: uint32(sequence),
        throttle: 255,
        brake: 0,
        steering: steeringPhase < 2 ? 18_000 : -18_000,
        suspensions: 0,
        flags: 0,
    }
}

class BenchmarkClient
{
    constructor(index, url, aggregate)
    {
        this.index = index
        this.aggregate = aggregate
        this.socket = new WebSocket(url)
        this.socket.binaryType = 'arraybuffer'
        this.router = new FrameRouter(this.socket)
        this.playerId = null
        this.entityOrder = null
        this.active = false
        this.lastServerTick = null
        this.predictionTick = null
        this.sequence = 0
        this.pendingInputs = []
        this.closedByHarness = false

        this.router.onFrame((type, data) =>
        {
            if(type === FRAME_TYPES.STATE)
                this.acceptState(data)
        })
        this.socket.addEventListener('close', () =>
        {
            if(!this.closedByHarness)
                this.aggregate.disconnects++
        })
        this.socket.addEventListener('error', () =>
        {
            if(!this.closedByHarness)
                this.aggregate.socketErrors++
        })
    }

    async connect()
    {
        await waitForOpen(this.socket)
        const required = decodeErrorFrame(
            binaryBytes(await this.router.waitFor(FRAME_TYPES.ERROR)),
        )
        if(required.message !== 'HELLO_REQUIRED')
            throw new Error(`client ${this.index} expected HELLO_REQUIRED`)

        this.socket.send(encodeHello({ clientTick: 0 }))
        const grant = decodeResume(
            binaryBytes(await this.router.waitFor(FRAME_TYPES.RESUME)),
        )
        const fullSync = decodeFullSyncFrame(
            binaryBytes(await this.router.waitFor(FRAME_TYPES.FULL_SYNC)),
        )
        const descriptor = fullSync.entities.find(
            (entity) => entity.playerId === grant.playerId,
        )
        if(!descriptor)
            throw new Error(`client ${this.index} did not receive its entity descriptor`)

        this.playerId = grant.playerId
        this.entityOrder = descriptor.entityOrder
        this.socket.send(encodeSyncReady())
    }

    acceptState(data)
    {
        const state = decodeStateFrame(binaryBytes(data))
        const computed = checksum32(state.states) >>> 0
        if(computed !== state.checksum32)
            this.aggregate.checksumMismatches++

        if(this.lastServerTick !== null)
        {
            const delta = tickDelta(state.serverTick, this.lastServerTick)
            if(delta !== STATE_INTERVAL_TICKS)
            {
                this.aggregate.stateGaps++
                this.aggregate.backlogPersistent++
            }
        }
        this.lastServerTick = state.serverTick
        this.aggregate.stateFrames++

        const tickEntry = this.aggregate.byTick.get(state.serverTick) ?? new Map()
        tickEntry.set(this.index, state.checksum32)
        this.aggregate.byTick.set(state.serverTick, tickEntry)
        const checksums = new Set(tickEntry.values())
        if(checksums.size > 1)
            this.aggregate.crossClientMismatches.add(state.serverTick)
        if(tickEntry.size === this.aggregate.clientCount)
            this.aggregate.byTick.delete(state.serverTick)

        if(state.worldHash !== null)
        {
            const hash = [ ...state.worldHash.sha256 ]
                .map((value) => value.toString(16).padStart(2, '0'))
                .join('')
            const known = this.aggregate.worldHashes.get(state.worldHash.hashTick)
            if(known !== undefined && known !== hash)
                this.aggregate.hashMismatches.add(state.worldHash.hashTick)
            else
                this.aggregate.worldHashes.set(state.worldHash.hashTick, hash)
        }

        if(
            this.entityOrder !== null
            && state.states.some((entity) => entity.entityOrder === this.entityOrder)
        )
            this.active = true
    }

    sample(scheduleTick)
    {
        if(this.lastServerTick === null)
            throw new Error(`client ${this.index} cannot sample before first STATE`)

        this.predictionTick = nextBenchmarkPredictionTick(
            this.lastServerTick,
            this.predictionTick,
        )
        const commandTick = commandTickForBenchmarkPrediction(this.predictionTick)
        const sequence = this.sequence
        this.sequence = tickAdd(this.sequence, 1)
        this.pendingInputs.push(createQuantizedInput(
            commandTick,
            sequence,
            scheduleTick,
            this.index,
        ))
        if(this.pendingInputs.length >= 3)
            this.flush()
    }

    flush()
    {
        if(this.pendingInputs.length === 0)
            return
        const batch = this.pendingInputs.splice(0, 6)
        this.socket.send(encodeInputBatch(batch))
    }

    async requestSummary(token)
    {
        const response = this.router.waitFor(BENCHMARK_FRAME_TYPES.SUMMARY, 10_000)
        this.socket.send(encodeBenchmarkSummaryRequest({
            tokenDigest: await digestBenchmarkToken(token),
        }))
        return decodeBenchmarkSummary(binaryBytes(await response))
    }

    close()
    {
        this.closedByHarness = true
        this.socket.close(1000, 'benchmark complete')
    }
}

async function runInputSchedule(clients, seconds, aggregate)
{
    const ticks = seconds * TICK_RATE_HZ
    const started = performance.now()
    for(let tick = 1; tick <= ticks; tick++)
    {
        const target = started + tick * (1000 / TICK_RATE_HZ)
        const delay = target - performance.now()
        if(delay > 0)
            await sleep(delay)
        else if(delay < -1000 / TICK_RATE_HZ)
            aggregate.sendDeadlineMisses++

        for(const client of clients)
            client.sample(tick)
    }
    for(const client of clients)
        client.flush()
    return { ticks, wallDurationMs: performance.now() - started }
}

function resetClientMeasurementAggregate(aggregate)
{
    aggregate.stateFrames = 0
    aggregate.stateGaps = 0
    aggregate.backlogPersistent = 0
    aggregate.checksumMismatches = 0
    aggregate.crossClientMismatches.clear()
    aggregate.hashMismatches.clear()
    aggregate.byTick.clear()
    aggregate.worldHashes.clear()
    aggregate.sendDeadlineMisses = 0
}

export async function runServerTickAlignedNodeLoadTest(options)
{
    const url = buildNodeBenchmarkWebSocketUrl(options.url, options.room)
    const aggregate = {
        clientCount: options.clients,
        disconnects: 0,
        socketErrors: 0,
        stateFrames: 0,
        stateGaps: 0,
        backlogPersistent: 0,
        checksumMismatches: 0,
        crossClientMismatches: new Set(),
        hashMismatches: new Set(),
        byTick: new Map(),
        worldHashes: new Map(),
        sendDeadlineMisses: 0,
    }
    const clients = Array.from(
        { length: options.clients },
        (_, index) => new BenchmarkClient(index, url, aggregate),
    )

    try
    {
        await Promise.all(clients.map((client) => client.connect()))
        await waitUntil(
            () => clients.every((client) => client.active),
            30_000,
            'all eight authoritative spawns',
        )

        const warmup = await runInputSchedule(
            clients,
            NETWORK_WARMUP_SECONDS,
            aggregate,
        )
        const warmupSummary = await clients[0].requestSummary(options.token)
        if(warmupSummary.mode !== 'node')
        {
            throw new Error(
                `expected Node warmup summary, received ${warmupSummary.mode ?? 'unknown'}`,
            )
        }
        resetClientMeasurementAggregate(aggregate)

        const measurementStartedAt = new Date().toISOString()
        const schedule = await runInputSchedule(clients, options.seconds, aggregate)
        const serverSummary = await clients[0].requestSummary(options.token)
        if(serverSummary.mode !== 'node')
        {
            throw new Error(
                `expected Node benchmark summary, received ${serverSummary.mode ?? 'unknown'}`,
            )
        }

        const serverMetrics = serverSummary.metrics ?? {}
        return {
            schemaVersion: 1,
            mode: 'deployed-node',
            metadata: {
                room: options.room,
                clients: options.clients,
                seconds: options.seconds,
                tickRateHz: TICK_RATE_HZ,
                expectedStateRateHz: 20,
                commandLeadTicks: INITIAL_PREDICTION_LEAD_TICKS,
                inputBufferTicks: INPUT_BUFFER_TICKS,
                networkWarmupTicks: warmup.ticks,
                networkWarmupSeconds: NETWORK_WARMUP_SECONDS,
                warmupServerTick: warmupSummary.currentTick,
                commit: options.commit,
                endpoint: `${url.protocol}//${url.host}${url.pathname}`,
                tokenConfigured: true,
                startedAt: measurementStartedAt,
                sentTicks: schedule.ticks,
                wallDurationMs: schedule.wallDurationMs,
            },
            server: {
                ...serverMetrics,
                observedPeakMemoryBytes: Number(
                    serverSummary.observedPeakMemoryBytes ?? Number.NaN,
                ),
                memoryScope: serverSummary.memoryScope ?? 'node-process-rss',
            },
            disconnects: aggregate.disconnects,
            socketErrors: aggregate.socketErrors,
            backlog: {
                stateGaps: aggregate.stateGaps,
                sendDeadlineMisses: aggregate.sendDeadlineMisses,
                persistent: aggregate.backlogPersistent,
            },
            divergence: {
                checksumMismatches: aggregate.checksumMismatches,
                crossClientChecksumTicks: aggregate.crossClientMismatches.size,
                worldHashTicks: aggregate.hashMismatches.size,
                persistent: aggregate.checksumMismatches
                    + aggregate.crossClientMismatches.size
                    + aggregate.hashMismatches.size,
            },
            roomRestarts: Number(
                serverSummary.roomRestarts ?? Number.POSITIVE_INFINITY,
            ),
            serverSummaryMetadata: {
                currentTick: serverSummary.currentTick,
                runtimeStarts: serverSummary.runtimeStarts,
                rapierVersion: serverSummary.rapierVersion,
                versions: serverSummary.versions,
                rapierInternalTimingAvailable:
                    serverSummary.rapierInternalTimingAvailable,
            },
        }
    }
    finally
    {
        for(const client of clients)
            client.close()
    }
}
