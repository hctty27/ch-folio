import {
    BENCHMARK_FRAME_TYPES,
    FRAME_TYPES,
    decodeBenchmarkSummary,
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeResume,
    decodeStateFrame,
    digestBenchmarkToken,
    encodeBenchmarkSummaryRequest,
    encodeHello,
    encodeSyncReady,
} from '@ch-folio/authoritative-physics'
import { buildNodeBenchmarkWebSocketUrl } from './loadtest-authoritative-node.mjs'

function bytes(value)
{
    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)
    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError('staging smoke received non-binary WebSocket data')
}

function frameType(value)
{
    const frame = bytes(value)
    if(frame.byteLength < 8)
        throw new Error('staging smoke received a frame shorter than its header')
    return frame[0]
}

class FrameRouter
{
    constructor(socket)
    {
        this.waiters = new Map()
        socket.addEventListener('message', (event) => this.route(event.data))
    }

    route(data)
    {
        const type = frameType(data)
        const queue = this.waiters.get(type) ?? []
        const waiter = queue.find((entry) => entry.resolve)
        if(waiter)
        {
            queue.splice(queue.indexOf(waiter), 1)
            waiter.resolve(data)
        }
        else
            queue.push({ buffered: data })
        this.waiters.set(type, queue)
    }

    waitFor(type, timeoutMs = 10_000)
    {
        const queue = this.waiters.get(type) ?? []
        const buffered = queue.find((entry) => 'buffered' in entry)
        if(buffered)
        {
            queue.splice(queue.indexOf(buffered), 1)
            this.waiters.set(type, queue)
            return Promise.resolve(buffered.buffered)
        }

        return new Promise((resolve, reject) =>
        {
            const timeout = setTimeout(() =>
            {
                const current = this.waiters.get(type) ?? []
                const index = current.findIndex((entry) => entry.resolve === wrappedResolve)
                if(index >= 0)
                    current.splice(index, 1)
                reject(new Error(`timed out waiting for frame type ${type}`))
            }, timeoutMs)
            const wrappedResolve = (value) =>
            {
                clearTimeout(timeout)
                resolve(value)
            }
            queue.push({ resolve: wrappedResolve })
            this.waiters.set(type, queue)
        })
    }
}

function waitForOpen(socket, timeoutMs = 10_000)
{
    return new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(() => reject(new Error('timed out opening staging WebSocket')), timeoutMs)
        socket.addEventListener('open', () =>
        {
            clearTimeout(timeout)
            resolve()
        }, { once: true })
        socket.addEventListener('error', () =>
        {
            clearTimeout(timeout)
            reject(new Error('staging WebSocket failed to open'))
        }, { once: true })
    })
}

function parseOptions(argv = process.argv.slice(2), environment = process.env)
{
    const values = new Map()
    for(const argument of argv)
    {
        if(!argument.startsWith('--') || !argument.includes('='))
            throw new Error(`unknown smoke argument ${argument}`)
        const separator = argument.indexOf('=')
        values.set(argument.slice(2, separator), argument.slice(separator + 1))
    }

    const url = values.get('url') ?? environment.AUTHORITATIVE_BENCHMARK_URL
    const token = environment.AUTHORITATIVE_BENCHMARK_TOKEN
    const room = values.get('room') ?? `node-staging-smoke-${Date.now()}`
    if(typeof url !== 'string' || url.length === 0)
        throw new Error('staging WebSocket URL is required')
    if(typeof token !== 'string' || token.length < 32)
        throw new Error('AUTHORITATIVE_BENCHMARK_TOKEN must contain at least 32 characters')
    return { url, token, room }
}

export async function runStagingSmoke(options)
{
    const url = buildNodeBenchmarkWebSocketUrl(options.url, options.room)
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const router = new FrameRouter(socket)

    try
    {
        await waitForOpen(socket)
        const required = decodeErrorFrame(bytes(await router.waitFor(FRAME_TYPES.ERROR)))
        if(required.message !== 'HELLO_REQUIRED')
            throw new Error(`expected HELLO_REQUIRED, received ${required.message}`)

        socket.send(encodeHello({ clientTick: 0 }))
        const grant = decodeResume(bytes(await router.waitFor(FRAME_TYPES.RESUME)))
        const fullSync = decodeFullSyncFrame(bytes(await router.waitFor(FRAME_TYPES.FULL_SYNC)))
        const descriptor = fullSync.entities.find((entity) => entity.playerId === grant.playerId)
        if(!descriptor)
            throw new Error('FULL_SYNC did not contain the smoke client entity')

        socket.send(encodeSyncReady())
        let activeState = null
        const deadline = Date.now() + 30_000
        while(Date.now() < deadline)
        {
            const state = decodeStateFrame(bytes(await router.waitFor(FRAME_TYPES.STATE, 10_000)))
            if(state.states.some((entity) => entity.entityOrder === descriptor.entityOrder))
            {
                activeState = state
                break
            }
        }
        if(activeState === null)
            throw new Error('smoke client never became active')

        const summaryPromise = router.waitFor(BENCHMARK_FRAME_TYPES.SUMMARY, 10_000)
        socket.send(encodeBenchmarkSummaryRequest({
            tokenDigest: await digestBenchmarkToken(options.token),
        }))
        const summary = decodeBenchmarkSummary(bytes(await summaryPromise))
        if(summary.mode !== 'node')
            throw new Error(`expected Node benchmark summary, received ${summary.mode ?? 'unknown'}`)

        return {
            schemaVersion: 1,
            mode: 'node-staging-smoke',
            endpoint: `${url.protocol}//${url.host}${url.pathname}`,
            serverTick: summary.currentTick,
            rapierVersion: summary.rapierVersion,
            versions: summary.versions,
            pass: true,
        }
    }
    finally
    {
        socket.close(1000, 'staging smoke complete')
    }
}

async function main()
{
    try
    {
        const report = await runStagingSmoke(parseOptions())
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
    catch(error)
    {
        process.stderr.write(`${JSON.stringify({
            schemaVersion: 1,
            mode: 'node-staging-smoke',
            error: error instanceof Error ? error.message : String(error),
            pass: false,
        })}\n`)
        process.exitCode = 1
    }
}

await main()
