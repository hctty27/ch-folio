import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
    BENCHMARK_FRAME_TYPES,
    FRAME_TYPES,
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
import { normalizeRoom } from '../sources/Game/MultiplayerV2/Server.js'

const DEFAULT_CLIENTS = 8
const DEFAULT_SECONDS = 600
const TICK_RATE_HZ = 60
const STATE_INTERVAL_TICKS = 3
const MAX_MEMORY_BYTES = 96 * 1024 * 1024
const CREDENTIAL_QUERY_KEYS = [
    'token',
    'resumeToken',
    'resume_token',
    'playerId',
    'lastServerTick',
]

function positiveInteger(value, label)
{
    const number = Number(value)
    if(!Number.isSafeInteger(number) || number < 1)
        throw new TypeError(`${label} must be a positive safe integer`)
    return number
}

function optionalFiniteNumber(value, label)
{
    if(value === undefined || value === null || value === '')
        return null
    const number = Number(value)
    if(!Number.isFinite(number) || number < 0)
        throw new TypeError(`${label} must be a finite non-negative number`)
    return number
}

function argumentMap(argv)
{
    const values = new Map()
    for(const argument of argv)
    {
        if(!argument.startsWith('--') || !argument.includes('='))
            throw new Error(`unknown load-test argument ${argument}`)
        const separator = argument.indexOf('=')
        values.set(argument.slice(2, separator), argument.slice(separator + 1))
    }
    return values
}

export function parseLoadTestOptions(argv = process.argv.slice(2), environment = process.env)
{
    const args = argumentMap(argv)
    const url = args.get('url') ?? environment.AUTHORITATIVE_BENCHMARK_URL
    const token = args.get('token') ?? environment.AUTHORITATIVE_BENCHMARK_TOKEN
    const room = normalizeRoom(
        args.get('room')
        ?? environment.AUTHORITATIVE_BENCHMARK_ROOM
        ?? `benchmark-${Date.now()}`,
    )
    const clients = positiveInteger(
        args.get('clients') ?? environment.AUTHORITATIVE_BENCHMARK_CLIENTS ?? DEFAULT_CLIENTS,
        'clients',
    )
    const seconds = positiveInteger(
        args.get('seconds') ?? environment.AUTHORITATIVE_BENCHMARK_SECONDS ?? DEFAULT_SECONDS,
        'seconds',
    )
    const workerVersion = args.get('worker-version')
        ?? environment.AUTHORITATIVE_BENCHMARK_WORKER_VERSION
        ?? null
    const regionObservation = args.get('region')
        ?? environment.AUTHORITATIVE_BENCHMARK_REGION
        ?? null
    const observedPeakMemoryBytes = optionalFiniteNumber(
        args.get('memory-bytes') ?? environment.AUTHORITATIVE_BENCHMARK_MEMORY_BYTES,
        'memory-bytes',
    )

    if(typeof url !== 'string' || url.length === 0)
        throw new Error('authoritative benchmark WebSocket URL is required')
    if(typeof token !== 'string' || token.length < 32)
        throw new Error('authoritative benchmark token must contain at least 32 characters')
    if(clients !== DEFAULT_CLIENTS)
        throw new Error(`deployed authoritative benchmark requires exactly ${DEFAULT_CLIENTS} clients`)

    return {
        url,
        token,
        room,
        clients,
        seconds,
        workerVersion,
        regionObservation,
        observedPeakMemoryBytes,
        metadata: {
            tokenConfigured: true,
            workerVersion,
            regionObservation,
            observedPeakMemoryBytes,
        },
    }
}

export function buildBenchmarkWebSocketUrl(baseUrl, room)
{
    const url = new URL(baseUrl)
    if(url.protocol !== 'ws:' && url.protocol !== 'wss:')
        throw new TypeError('benchmark URL must use ws or wss')
    url.searchParams.set('room', normalizeRoom(room))
    url.searchParams.set('protocol', '2')
    for(const key of CREDENTIAL_QUERY_KEYS)
        url.searchParams.delete(key)
    return url
}

function failure(failures, gate, actual, limit, comparison = '<=')
{
    failures.push({ gate, actual, limit, comparison })
}

function finiteOrInfinity(value)
{
    return Number.isFinite(value) ? Number(value) : Number.POSITIVE_INFINITY
}

export function evaluateLoadTestGates(report)
{
    const failures = []
    const totalTick = report?.worker?.phases?.totalTick ?? {}
    const p95 = finiteOrInfinity(totalTick.p95Ms)
    const p99 = finiteOrInfinity(totalTick.p99Ms)
    const max = finiteOrInfinity(totalTick.maxMs)
    const queue = finiteOrInfinity(report?.worker?.gauges?.maxQueueDepth)
    const overload = finiteOrInfinity(report?.worker?.scheduler?.overloadCallbacks)
    const memory = finiteOrInfinity(report?.worker?.observedPeakMemoryBytes)
    const disconnects = finiteOrInfinity(report?.disconnects)
    const backlog = finiteOrInfinity(report?.backlog?.persistent)
    const divergence = finiteOrInfinity(report?.divergence?.persistent)
    const roomRestarts = finiteOrInfinity(report?.roomRestarts)

    if(p95 > 8) failure(failures, 'worker.totalTick.p95Ms', p95, 8)
    if(p99 > 12) failure(failures, 'worker.totalTick.p99Ms', p99, 12)
    if(max > 16.67) failure(failures, 'worker.totalTick.maxMs', max, 16.67)
    if(queue > 3) failure(failures, 'worker.gauges.maxQueueDepth', queue, 3)
    if(overload > 0) failure(failures, 'worker.scheduler.overloadCallbacks', overload, 0)
    if(memory > MAX_MEMORY_BYTES) failure(failures, 'worker.observedPeakMemoryBytes', memory, MAX_MEMORY_BYTES)
    if(disconnects > 0) failure(failures, 'disconnects', disconnects, 0)
    if(backlog > 0) failure(failures, 'backlog.persistent', backlog, 0)
    if(divergence > 0) failure(failures, 'divergence.persistent', divergence, 0)
    if(roomRestarts > 0) failure(failures, 'roomRestarts', roomRestarts, 0)

    return { pass: failures.length === 0, failures }
}

function binaryBytes(value)
{
    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)
    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError('benchmark WebSocket received non-binary data')
}

function frameType(value)
{
    const frame = binaryBytes(value)
    if(frame.byteLength < 8)
        throw new Error('benchmark WebSocket frame is shorter than its header')
    return frame[0]
}

class FrameRouter
{
    constructor(socket)
    {
        this.socket = socket
        this.waiters = new Map()
        this.listeners = new Set()
        socket.addEventListener('message', (event) => this.route(event.data))
    }

    route(data)
    {
        try
        {
            const type = frameType(data)
            const queue = this.waiters.get(type)
            if(queue?.length)
                queue.shift().resolve(data)
            else
            {
                const pending = this.waiters.get(type) ?? []
                pending.push({ buffered: data })
                this.waiters.set(type, pending)
            }

            for(const listener of this.listeners)
                listener(type, data)
        }
        catch(error)
        {
            for(const listener of this.listeners)
                listener(-1, error)
        }
    }

    onFrame(listener)
    {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    waitFor(type, timeoutMs = 5000)
    {
        const queue = this.waiters.get(type) ?? []
        const bufferedIndex = queue.findIndex((entry) => 'buffered' in entry)
        if(bufferedIndex >= 0)
        {
            const [ entry ] = queue.splice(bufferedIndex, 1)
            this.waiters.set(type, queue)
            return Promise.resolve(entry.buffered)
        }

        return new Promise((resolve, reject) =>
        {
            const timeout = setTimeout(() =>
            {
                const current = this.waiters.get(type) ?? []
                const index = current.findIndex((entry) => entry.resolve === resolve)
                if(index >= 0)
                    current.splice(index, 1)
                reject(new Error(`timed out waiting for frame type ${type}`))
            }, timeoutMs)
            queue.push({
                resolve: (value) =>
                {
                    clearTimeout(timeout)
                    resolve(value)
                },
                reject,
            })
            this.waiters.set(type, queue)
        })
    }
}

function waitForOpen(socket, timeoutMs = 5000)
{
    return new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(() => reject(new Error('timed out opening benchmark WebSocket')), timeoutMs)
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

function createQuantizedInput(tick, clientIndex)
{
    const steeringPhase = (Math.floor(tick / 120) + clientIndex) % 4
    return {
        clientTick: tick >>> 0,
        sequence: tick >>> 0,
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
        this.url = url
        this.aggregate = aggregate
        this.socket = new WebSocket(url)
        this.socket.binaryType = 'arraybuffer'
        this.router = new FrameRouter(this.socket)
        this.playerId = null
        this.entityOrder = null
        this.active = false
        this.lastServerTick = null
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
        const required = decodeErrorFrame(binaryBytes(await this.router.waitFor(FRAME_TYPES.ERROR)))
        if(required.message !== 'HELLO_REQUIRED')
            throw new Error(`client ${this.index} expected HELLO_REQUIRED`)

        this.socket.send(encodeHello({ clientTick: 0 }))
        const grant = decodeResume(binaryBytes(await this.router.waitFor(FRAME_TYPES.RESUME)))
        const fullSync = decodeFullSyncFrame(binaryBytes(await this.router.waitFor(FRAME_TYPES.FULL_SYNC)))
        const descriptor = fullSync.entities.find((entity) => entity.playerId === grant.playerId)
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
            const delta = state.serverTick - this.lastServerTick
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

        if(this.entityOrder !== null && state.states.some((entity) => entity.entityOrder === this.entityOrder))
            this.active = true
    }

    sample(tick)
    {
        this.pendingInputs.push(createQuantizedInput(tick, this.index))
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

function sleep(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
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

export async function runDeployedLoadTest(options)
{
    const url = buildBenchmarkWebSocketUrl(options.url, options.room)
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
    const clients = Array.from({ length: options.clients }, (_, index) =>
        new BenchmarkClient(index, url, aggregate))

    try
    {
        await Promise.all(clients.map((client) => client.connect()))
        await waitUntil(
            () => clients.every((client) => client.active),
            30_000,
            'all eight authoritative spawns',
        )
        const schedule = await runInputSchedule(clients, options.seconds, aggregate)
        const workerSummary = await clients[0].requestSummary(options.token)
        const workerMetrics = workerSummary.metrics ?? {}
        const report = {
            schemaVersion: 1,
            mode: 'deployed-durable-object',
            metadata: {
                room: options.room,
                clients: options.clients,
                seconds: options.seconds,
                tickRateHz: TICK_RATE_HZ,
                expectedStateRateHz: 20,
                workerVersion: options.workerVersion,
                regionObservation: options.regionObservation,
                endpoint: `${url.protocol}//${url.host}${url.pathname}`,
                tokenConfigured: true,
                startedAt: new Date().toISOString(),
                sentTicks: schedule.ticks,
                wallDurationMs: schedule.wallDurationMs,
            },
            worker: {
                ...workerMetrics,
                observedPeakMemoryBytes: options.observedPeakMemoryBytes,
                memoryScope: 'cloudflare-v8-isolate-observation',
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
            roomRestarts: Number(workerSummary.roomRestarts ?? Number.POSITIVE_INFINITY),
            workerSummaryMetadata: {
                currentTick: workerSummary.currentTick,
                runtimeStarts: workerSummary.runtimeStarts,
                rapierVersion: workerSummary.rapierVersion,
                versions: workerSummary.versions,
                rapierInternalTimingAvailable: workerSummary.rapierInternalTimingAvailable,
            },
        }
        report.gates = evaluateLoadTestGates(report)
        return report
    }
    finally
    {
        for(const client of clients)
            client.close()
    }
}

async function main()
{
    try
    {
        const options = parseLoadTestOptions()
        const report = await runDeployedLoadTest(options)
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        if(!report.gates.pass)
            process.exitCode = 1
    }
    catch(error)
    {
        process.stderr.write(`${JSON.stringify({
            schemaVersion: 1,
            mode: 'deployed-durable-object',
            error: error instanceof Error ? error.message : String(error),
        })}\n`)
        process.exitCode = 1
    }
}

const isMain = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if(isMain)
    await main()
