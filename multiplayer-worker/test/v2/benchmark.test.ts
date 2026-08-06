import {
    SELF,
    runInDurableObject,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import {
    decodeBenchmarkSummary,
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeResume,
    digestBenchmarkToken,
    encodeBenchmarkSummaryRequest,
    encodeHello,
} from '@ch-folio/authoritative-physics'
import { describe, expect, test } from 'vitest'

import { Metrics } from '../../src/v2/Metrics'

type RuntimeProbe = {
    scheduler: { stop(): boolean }
    advanceOneTick(): void
}

function binaryMessage(data: unknown): ArrayBuffer
{
    if(data instanceof ArrayBuffer)
        return data
    if(ArrayBuffer.isView(data))
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    throw new TypeError('expected binary WebSocket data')
}

function nextMessage(socket: WebSocket): Promise<MessageEvent>
{
    return new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for WebSocket message')), 2000)
        socket.addEventListener('message', (event) =>
        {
            clearTimeout(timeout)
            resolve(event)
        }, { once: true })
        socket.addEventListener('error', () =>
        {
            clearTimeout(timeout)
            reject(new Error('WebSocket emitted an error'))
        }, { once: true })
    })
}

async function openActiveSocket(room: string): Promise<WebSocket>
{
    const response = await SELF.fetch(
        `https://worker.test/ws?room=${encodeURIComponent(room)}&protocol=2`,
        { headers: { Upgrade: 'websocket' } },
    )
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    socket.binaryType = 'arraybuffer'
    socket.accept()
    expect(decodeErrorFrame(binaryMessage((await nextMessage(socket)).data)).message)
        .toBe('HELLO_REQUIRED')

    const grantPromise = nextMessage(socket)
    const syncPromise = nextMessage(socket)
    socket.send(encodeHello({ clientTick: 0 }))
    decodeResume(binaryMessage((await grantPromise).data))
    decodeFullSyncFrame(binaryMessage((await syncPromise).data))
    return socket
}

describe('benchmark metrics', () =>
{
    test('retains an exact bounded per-tick ten-minute window', () =>
    {
        const metrics = new Metrics()
        for(let tick = 1; tick <= 36_005; tick++)
        {
            metrics.recordPhase('totalTick', tick / 1000)
            metrics.recordQueueDepth(tick === 36_005 ? 3 : 1)
            metrics.completeTick(tick)
        }

        const summary = metrics.readBenchmarkSummary()
        expect(summary).toMatchObject({
            startTick: 6,
            endTick: 36_005,
            ticks: 36_000,
            gauges: { maxQueueDepth: 3 },
        })
        expect(summary.phases.totalTick).toMatchObject({
            count: 36_000,
            maxMs: 36.005,
        })
    })
})

describe('authenticated benchmark summary', () =>
{
    test('returns bounded machine JSON without echoing the secret', async () =>
    {
        const room = `benchmark-${crypto.randomUUID()}`
        const socket = await openActiveSocket(room)
        const stub = env.AUTHORITATIVE_ROOM.getByName(room)

        await runInDurableObject(stub, async (instance) =>
        {
            const runtime = instance as unknown as RuntimeProbe
            runtime.scheduler.stop()
            runtime.advanceOneTick()
            runtime.advanceOneTick()
            runtime.advanceOneTick()
        })

        const responsePromise = nextMessage(socket)
        socket.send(encodeBenchmarkSummaryRequest({
            tokenDigest: await digestBenchmarkToken('task-18-worker-test-secret-at-least-32-chars'),
        }))
        const summary = decodeBenchmarkSummary(binaryMessage((await responsePromise).data))

        expect(summary).toMatchObject({
            schemaVersion: 1,
            mode: 'durable-object',
            room,
            currentTick: 3,
            metrics: { ticks: 3 },
        })
        expect(JSON.stringify(summary)).not.toContain('task-18-worker-test-secret')
        socket.close(1000, 'done')
    })
})
