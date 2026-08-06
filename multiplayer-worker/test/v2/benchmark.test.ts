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
    return collectMessages(socket, 1, () => undefined)
        .then(([ message ]) => message)
}

function collectMessages(
    socket: WebSocket,
    count: number,
    action: () => void | Promise<void>,
): Promise<MessageEvent[]>
{
    return new Promise((resolve, reject) =>
    {
        const messages: MessageEvent[] = []
        const timeout = setTimeout(() =>
        {
            cleanup()
            reject(new Error(`expected ${count} WebSocket messages, received ${messages.length}`))
        }, 2000)
        const cleanup = (): void =>
        {
            clearTimeout(timeout)
            socket.removeEventListener('message', onMessage)
            socket.removeEventListener('error', onError)
        }
        const onMessage = (event: MessageEvent): void =>
        {
            messages.push(event)
            if(messages.length === count)
            {
                cleanup()
                resolve(messages)
            }
        }
        const onError = (): void =>
        {
            cleanup()
            reject(new Error('WebSocket emitted an error'))
        }

        socket.addEventListener('message', onMessage)
        socket.addEventListener('error', onError, { once: true })
        Promise.resolve(action()).catch((error: unknown) =>
        {
            cleanup()
            reject(error)
        })
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

    const [ grantMessage, syncMessage ] = await collectMessages(
        socket,
        2,
        () => socket.send(encodeHello({ clientTick: 0 })),
    )
    decodeResume(binaryMessage(grantMessage.data))
    decodeFullSyncFrame(binaryMessage(syncMessage.data))
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
