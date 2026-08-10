import {
    SELF,
    evictDurableObject,
    runInDurableObject,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import {
    decodeErrorFrame,
    decodeResume,
    encodeHello,
} from '@ch-folio/authoritative-physics'
import { describe, expect, test } from 'vitest'

import { AuthoritativeGameRoom } from '../../src/v2/AuthoritativeGameRoom'
import { Metrics } from '../../src/v2/Metrics'
import { SESSION_GRACE_TICKS } from '../../src/v2/SessionRegistry'

type RuntimeProbe = {
    scheduler: {
        running: boolean
    }
    sessions: {
        size: number
    }
    authoritativeMap: unknown | null
    authoritativeWorld: unknown | null
    simulation: unknown | null
    advanceOneTick(): void
    webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
    ): void
}

type SessionAttachment = {
    handshake?: string
    playerId?: number | null
    generation?: number | null
}

function binary(data: unknown): ArrayBuffer
{
    if(data instanceof ArrayBuffer)
        return data
    if(ArrayBuffer.isView(data))
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    throw new TypeError('expected a binary WebSocket message')
}

function message(socket: WebSocket): Promise<MessageEvent>
{
    return new Promise((resolve, reject) =>
    {
        socket.addEventListener('message', resolve, { once: true })
        socket.addEventListener('error', () => reject(new Error('socket error')), { once: true })
    })
}

function probe(instance: AuthoritativeGameRoom): RuntimeProbe
{
    return instance as unknown as RuntimeProbe
}

describe('authoritative runtime lifecycle', () =>
{
    test('fully resets metrics between room lifetimes', () =>
    {
        const metrics = new Metrics()
        metrics.recordPhase('decode', 4)
        metrics.recordSchedulerCallback(6, 3)
        metrics.recordQueueDepth(5)
        metrics.setSlots(2)

        metrics.reset()

        expect(metrics.readScheduler()).toEqual({
            callbacks: 0,
            catchUpTicks: 0,
            overloadCallbacks: 0,
            maxDueTicks: 0,
        })
        expect(metrics.completeTick(600)).toBeNull()

        let summary = null
        for(let tick = 601; tick <= 1199; tick++)
            summary = metrics.completeTick(tick)

        expect(summary).toMatchObject({
            startTick: 600,
            endTick: 1199,
            ticks: 600,
            phases: {},
            gauges: {
                queueDepth: 0,
                maxQueueDepth: 0,
                slots: 0,
                maxSlots: 0,
            },
        })
    })

    test('loads map and Rapier only after HELLO and releases both after final grace', async () =>
    {
        const room = `lazy-runtime-${crypto.randomUUID()}`
        const stub = env.AUTHORITATIVE_ROOM.getByName(room)

        await runInDurableObject(stub, async (instance) =>
        {
            const runtime = probe(instance)
            expect(runtime.authoritativeMap).toBeNull()
            expect(runtime.authoritativeWorld).toBeNull()
            expect(runtime.simulation).toBeNull()
            expect(runtime.scheduler.running).toBe(false)
        })

        const response = await SELF.fetch(
            `https://worker.test/ws?room=${encodeURIComponent(room)}&protocol=2`,
            { headers: { Upgrade: 'websocket' } },
        )
        const socket = response.webSocket!
        socket.binaryType = 'arraybuffer'
        socket.accept()
        expect(decodeErrorFrame(binary((await message(socket)).data)).message)
            .toBe('HELLO_REQUIRED')

        const grantMessage = message(socket)
        socket.send(encodeHello({ clientTick: 1 }))
        const grant = decodeResume(binary((await grantMessage).data))

        await runInDurableObject(stub, async (instance, state) =>
        {
            const runtime = probe(instance)
            expect(runtime.authoritativeMap).not.toBeNull()
            expect(runtime.authoritativeWorld).not.toBeNull()
            expect(runtime.simulation).not.toBeNull()
            expect(runtime.scheduler.running).toBe(true)

            const serverSocket = state.getWebSockets().find((candidate) =>
            {
                const attachment = candidate.deserializeAttachment() as SessionAttachment | null
                return attachment?.handshake === 'session_active'
                    && attachment.playerId === grant.playerId
                    && attachment.generation === 1
            })
            expect(serverSocket).toBeDefined()

            runtime.webSocketClose(serverSocket!, 1000, 'test complete', true)
            for(let tick = 0; tick < SESSION_GRACE_TICKS; tick++)
                runtime.advanceOneTick()

            expect(runtime.sessions.size).toBe(0)
            expect(runtime.scheduler.running).toBe(false)
            expect(runtime.authoritativeMap).toBeNull()
            expect(runtime.authoritativeWorld).toBeNull()
            expect(runtime.simulation).toBeNull()
        })

        await evictDurableObject(stub, { webSockets: 'close' })
    })
})
