import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildNodeBenchmarkWebSocketUrl,
    evaluateNodeLoadTestGates,
    parseNodeLoadTestOptions,
} from './loadtest-authoritative-node.mjs'
import { FRAME_TYPES } from '@ch-folio/authoritative-physics'

const TOKEN = 'node-benchmark-token-0123456789-abcdef'

class FakeSocket
{
    constructor()
    {
        this.listeners = new Map()
    }

    addEventListener(type, listener)
    {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
    }

    emitMessage(frame)
    {
        for(const listener of this.listeners.get('message') ?? [])
            listener({ data: frame })
    }
}

function frame(type)
{
    const bytes = new Uint8Array(8)
    bytes[0] = type
    return bytes
}

test('Node load options default to eight clients and 600 seconds without exposing credentials', () =>
{
    const options = parseNodeLoadTestOptions([], {
        AUTHORITATIVE_BENCHMARK_URL: 'wss://node.example/ws?token=leak&ignored=yes',
        AUTHORITATIVE_BENCHMARK_ROOM: '  Node_Load  ',
        AUTHORITATIVE_BENCHMARK_TOKEN: TOKEN,
        AUTHORITATIVE_BENCHMARK_COMMIT: '0123456789abcdef0123456789abcdef01234567',
    })

    assert.equal(options.clients, 8)
    assert.equal(options.seconds, 600)
    assert.equal(options.room, 'node_load')
    assert.equal(options.commit, '0123456789abcdef0123456789abcdef01234567')
    assert.equal(options.metadata.tokenConfigured, true)
    assert.equal(options.metadata.commit, options.commit)
    assert.equal('token' in options.metadata, false)

    const url = buildNodeBenchmarkWebSocketUrl(options.url, options.room)
    assert.equal(url.protocol, 'wss:')
    assert.equal(url.pathname, '/ws')
    assert.equal(url.searchParams.get('room'), 'node_load')
    assert.equal(url.searchParams.get('protocol'), '2')
    assert.equal(url.searchParams.has('token'), false)
    assert.equal(url.searchParams.has('resumeToken'), false)
    assert.equal(url.toString().includes(TOKEN), false)
})

test('Node load options fail closed on missing URL, short token, or non-eight client count', () =>
{
    assert.throws(
        () => parseNodeLoadTestOptions([], { AUTHORITATIVE_BENCHMARK_TOKEN: TOKEN }),
        /WebSocket URL is required/u,
    )
    assert.throws(
        () => parseNodeLoadTestOptions([], {
            AUTHORITATIVE_BENCHMARK_URL: 'wss://node.example/ws',
            AUTHORITATIVE_BENCHMARK_TOKEN: 'too-short',
        }),
        /at least 32 characters/u,
    )
    assert.throws(
        () => parseNodeLoadTestOptions([ '--clients=7' ], {
            AUTHORITATIVE_BENCHMARK_URL: 'wss://node.example/ws',
            AUTHORITATIVE_BENCHMARK_TOKEN: TOKEN,
        }),
        /exactly 8 clients/u,
    )
})

test('Node benchmark URL rejects non-WebSocket schemes and strips credential-like query keys', () =>
{
    assert.throws(
        () => buildNodeBenchmarkWebSocketUrl('https://node.example/ws', 'node-load'),
        /ws or wss/u,
    )

    const url = buildNodeBenchmarkWebSocketUrl(
        'wss://node.example/ws?resume_token=x&playerId=4&lastServerTick=9',
        'node-load',
    )
    assert.equal(url.searchParams.get('room'), 'node-load')
    assert.equal(url.searchParams.get('protocol'), '2')
    assert.equal(url.searchParams.has('resume_token'), false)
    assert.equal(url.searchParams.has('playerId'), false)
    assert.equal(url.searchParams.has('lastServerTick'), false)
})

test('FrameRouter delivers every continuous STATE frame to listeners', async () =>
{
    const module = await import('./loadtest-authoritative-node.mjs')
    assert.equal(typeof module.FrameRouter, 'function')

    const socket = new FakeSocket()
    const router = new module.FrameRouter(socket)
    const observed = []
    router.onFrame((type) => observed.push(type))

    socket.emitMessage(frame(FRAME_TYPES.STATE))
    socket.emitMessage(frame(FRAME_TYPES.STATE))
    socket.emitMessage(frame(FRAME_TYPES.STATE))

    assert.deepEqual(observed, [
        FRAME_TYPES.STATE,
        FRAME_TYPES.STATE,
        FRAME_TYPES.STATE,
    ])
})

test('FrameRouter retains one-shot frames that arrive before waitFor', async () =>
{
    const module = await import('./loadtest-authoritative-node.mjs')
    assert.equal(typeof module.FrameRouter, 'function')

    const socket = new FakeSocket()
    const router = new module.FrameRouter(socket)
    const expected = frame(FRAME_TYPES.ERROR)
    socket.emitMessage(expected)

    const received = await router.waitFor(FRAME_TYPES.ERROR)
    assert.equal(received, expected)
})

test('Node hosted gates pass at exact limits and do not treat RSS as the Durable Object 96 MiB gate', () =>
{
    const report = {
        server: {
            phases: { totalTick: { p95Ms: 8, p99Ms: 12, maxMs: 16.67 } },
            gauges: { maxQueueDepth: 3 },
            scheduler: { overloadCallbacks: 0 },
            observedPeakMemoryBytes: 512 * 1024 * 1024,
        },
        disconnects: 0,
        backlog: { persistent: 0 },
        divergence: { persistent: 0 },
        roomRestarts: 0,
    }

    const result = evaluateNodeLoadTestGates(report)
    assert.equal(result.pass, true)
    assert.deepEqual(result.failures, [])
})

test('Node hosted gates reject every timing, queue, overload, disconnect, backlog, divergence, and restart breach', () =>
{
    const report = {
        server: {
            phases: { totalTick: { p95Ms: 8.01, p99Ms: 12.01, maxMs: 16.68 } },
            gauges: { maxQueueDepth: 4 },
            scheduler: { overloadCallbacks: 1 },
            observedPeakMemoryBytes: 1024 * 1024 * 1024,
        },
        disconnects: 1,
        backlog: { persistent: 1 },
        divergence: { persistent: 1 },
        roomRestarts: 1,
    }

    const result = evaluateNodeLoadTestGates(report)
    assert.equal(result.pass, false)
    assert.deepEqual(result.failures.map(({ gate }) => gate), [
        'server.totalTick.p95Ms',
        'server.totalTick.p99Ms',
        'server.totalTick.maxMs',
        'server.gauges.maxQueueDepth',
        'server.scheduler.overloadCallbacks',
        'disconnects',
        'backlog.persistent',
        'divergence.persistent',
        'roomRestarts',
    ])
    assert.equal(result.failures.some(({ gate }) => gate.includes('memory')), false)
})
