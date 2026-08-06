import {
    SELF,
    evictDurableObject,
    runInDurableObject,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import {
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeResume,
    decodeStateFrame,
    encodeHello,
} from '@ch-folio/authoritative-physics'
import { describe, expect, test } from 'vitest'

import { AuthoritativeGameRoom } from '../../src/v2/AuthoritativeGameRoom'
import { Metrics } from '../../src/v2/Metrics'
import {
    TickScheduler,
    type TickSchedulerClock,
} from '../../src/v2/TickScheduler'

type ScheduledTask = {
    id: number
    dueMs: number
    callback: () => void
}

type SessionAttachment = {
    handshake?: string
    playerId?: number | null
    generation?: number | null
}

type RuntimeProbe = {
    scheduler: {
        running: boolean
        stop(): boolean
    }
    simulation: {
        currentTick: number
    } | null
    authoritativeWorld: unknown | null
    completedWorldHash: {
        hashTick: number
        sha256: Uint8Array
    } | null
    sessions: {
        size: number
    }
    advanceOneTick(): void
    webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
    ): void
}

class FakeClock implements TickSchedulerClock
{
    private currentMs = 0
    private nextId = 1
    private readonly tasks = new Map<number, ScheduledTask>()

    now(): number
    {
        return this.currentMs
    }

    setTimeout(callback: () => void, delayMs: number): number
    {
        const id = this.nextId++
        this.tasks.set(id, {
            id,
            dueMs: this.currentMs + Math.max(0, delayMs),
            callback,
        })
        return id
    }

    clearTimeout(handle: unknown): void
    {
        if(typeof handle === 'number')
            this.tasks.delete(handle)
    }

    get pendingCount(): number
    {
        return this.tasks.size
    }

    jumpBy(milliseconds: number): void
    {
        this.currentMs += milliseconds
    }

    runNext(): boolean
    {
        const next = [ ...this.tasks.values() ]
            .sort((left, right) =>
                left.dueMs - right.dueMs || left.id - right.id)[0]
        if(next === undefined || next.dueMs > this.currentMs)
            return false

        this.tasks.delete(next.id)
        next.callback()
        return true
    }

    advanceBy(milliseconds: number): void
    {
        const targetMs = this.currentMs + milliseconds

        while(true)
        {
            const next = [ ...this.tasks.values() ]
                .sort((left, right) =>
                    left.dueMs - right.dueMs || left.id - right.id)[0]
            if(next === undefined || next.dueMs > targetMs)
                break

            this.currentMs = next.dueMs
            this.tasks.delete(next.id)
            next.callback()
        }

        this.currentMs = targetMs
    }
}

function binaryMessage(data: unknown): ArrayBuffer
{
    if(data instanceof ArrayBuffer)
        return data

    if(ArrayBuffer.isView(data))
    {
        return data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
        ) as ArrayBuffer
    }

    throw new TypeError('expected a binary WebSocket message')
}

function nextMessage(socket: WebSocket): Promise<MessageEvent>
{
    return collectMessages(socket, 1, () => undefined)
        .then(([ message ]) => message)
}

async function collectMessages(
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
            reject(new Error('WebSocket emitted an error while collecting messages'))
        }

        socket.addEventListener('message', onMessage)
        socket.addEventListener('error', onError, { once: true })

        Promise.resolve()
            .then(action)
            .catch((error: unknown) =>
            {
                cleanup()
                reject(error)
            })
    })
}

async function openSocket(room: string): Promise<WebSocket>
{
    const response = await SELF.fetch(
        `https://worker.test/ws?room=${encodeURIComponent(room)}&protocol=2`,
        { headers: { Upgrade: 'websocket' } },
    )

    expect(response.status).toBe(101)
    expect(response.webSocket).not.toBeNull()

    const socket = response.webSocket!
    socket.binaryType = 'arraybuffer'
    socket.accept()

    const required = decodeErrorFrame(binaryMessage((await nextMessage(socket)).data))
    expect(required.message).toBe('HELLO_REQUIRED')
    return socket
}

function runtimeProbe(instance: AuthoritativeGameRoom): RuntimeProbe
{
    return instance as unknown as RuntimeProbe
}

async function waitForCompletedHash(room: string): Promise<void>
{
    const stub = env.AUTHORITATIVE_ROOM.getByName(room)

    for(let attempt = 0; attempt < 50; attempt++)
    {
        const ready = await runInDurableObject(stub, async (instance) =>
            runtimeProbe(instance).completedWorldHash !== null)
        if(ready)
            return

        await new Promise((resolve) => setTimeout(resolve, 0))
    }

    throw new Error('asynchronous world hash did not complete')
}

describe('TickScheduler', () =>
{
    test('start is idempotent and stop cancels the pending callback', () =>
    {
        const clock = new FakeClock()
        let ticks = 0
        const scheduler = new TickScheduler({
            clock,
            onTick: () => { ticks++ },
        })

        expect(scheduler.running).toBe(false)
        expect(scheduler.start()).toBe(true)
        expect(scheduler.start()).toBe(false)
        expect(scheduler.running).toBe(true)
        expect(clock.pendingCount).toBe(1)

        clock.advanceBy(17)
        expect(ticks).toBe(1)

        expect(scheduler.stop()).toBe(true)
        expect(scheduler.stop()).toBe(false)
        expect(scheduler.running).toBe(false)
        expect(clock.pendingCount).toBe(0)

        clock.advanceBy(100)
        expect(ticks).toBe(1)
    })

    test('advances exactly sixty logical ticks per second without elapsed-time arguments', () =>
    {
        const clock = new FakeClock()
        const argumentCounts: number[] = []
        const scheduler = new TickScheduler({
            clock,
            onTick: (...args: never[]) =>
            {
                argumentCounts.push(args.length)
            },
        })

        scheduler.start()
        clock.advanceBy(1000)

        expect(argumentCounts).toHaveLength(60)
        expect(argumentCounts.every((count) => count === 0)).toBe(true)
    })

    test('caps one delayed callback at three catch-up ticks and records overload', () =>
    {
        const clock = new FakeClock()
        const metrics = new Metrics()
        let ticks = 0
        const scheduler = new TickScheduler({
            clock,
            metrics,
            onTick: () => { ticks++ },
        })

        scheduler.start()
        clock.jumpBy(100)
        expect(clock.runNext()).toBe(true)

        expect(ticks).toBe(3)
        expect(clock.pendingCount).toBe(1)
        expect(metrics.readScheduler()).toEqual({
            callbacks: 1,
            catchUpTicks: 2,
            overloadCallbacks: 1,
            maxDueTicks: 6,
        })

        while(clock.runNext())
        {
            // Drain zero-delay catch-up callbacks at the same fake time.
        }
        expect(ticks).toBe(6)
    })

    test('may stop from inside the tick callback when the final slot releases', () =>
    {
        const clock = new FakeClock()
        let slots = 1
        let ticks = 0
        let scheduler: TickScheduler

        scheduler = new TickScheduler({
            clock,
            onTick: () =>
            {
                ticks++
                slots--
                if(slots === 0)
                    scheduler.stop()
            },
        })

        scheduler.start()
        clock.advanceBy(17)

        expect(ticks).toBe(1)
        expect(scheduler.running).toBe(false)
        expect(clock.pendingCount).toBe(0)
    })
})

describe('Metrics', () =>
{
    test('summarizes phase timings and gauges every six hundred ticks', () =>
    {
        const metrics = new Metrics()

        metrics.recordPhase('decode', 1)
        metrics.recordPhase('decode', 3)
        metrics.recordPhase('encode', 2)
        metrics.recordQueueDepth(4)
        metrics.setSlots(3)

        for(let tick = 1; tick < 600; tick++)
            expect(metrics.completeTick(tick)).toBeNull()

        const summary = metrics.completeTick(600)
        expect(summary).not.toBeNull()
        expect(summary).toMatchObject({
            startTick: 1,
            endTick: 600,
            ticks: 600,
            gauges: {
                queueDepth: 4,
                maxQueueDepth: 4,
                slots: 3,
                maxSlots: 3,
            },
        })
        expect(summary!.phases.decode).toMatchObject({
            count: 2,
            totalMs: 4,
            meanMs: 2,
            p50Ms: 1,
            p95Ms: 3,
            p99Ms: 3,
            maxMs: 3,
        })
        expect(summary!.phases.encode.count).toBe(1)

        expect(metrics.completeTick(601)).toBeNull()
    })
})

describe('AuthoritativeGameRoom runtime', () =>
{
    test('lazily broadcasts 20Hz state, defers hashes, and frees the final slot', async () =>
    {
        const room = `runtime-${crypto.randomUUID()}`
        const stub = env.AUTHORITATIVE_ROOM.getByName(room)
        const socket = await openSocket(room)

        await runInDurableObject(stub, async (instance) =>
        {
            const probe = runtimeProbe(instance)
            expect(probe.scheduler.running).toBe(false)
            expect(probe.simulation).toBeNull()
            expect(probe.authoritativeWorld).toBeNull()
        })

        const [ grantMessage, fullSyncMessage ] = await collectMessages(
            socket,
            2,
            () => socket.send(encodeHello({ clientTick: 10 })),
        )
        const grant = decodeResume(binaryMessage(grantMessage.data))
        const fullSync = decodeFullSyncFrame(binaryMessage(fullSyncMessage.data))

        expect(fullSync.entities).toHaveLength(1)
        expect(fullSync.entities[0]).toMatchObject({
            entityOrder: 1,
            playerId: grant.playerId,
        })

        await runInDurableObject(stub, async (instance) =>
        {
            const probe = runtimeProbe(instance)
            expect(probe.scheduler.running).toBe(true)
            expect(probe.simulation).not.toBeNull()
            expect(probe.authoritativeWorld).not.toBeNull()
            probe.scheduler.stop()
        })

        const stateMessages = await collectMessages(socket, 20, async () =>
        {
            await runInDurableObject(stub, async (instance) =>
            {
                const probe = runtimeProbe(instance)
                for(let tick = 0; tick < 60; tick++)
                    probe.advanceOneTick()
            })
        })
        const stateFrames = stateMessages.map((message) =>
            decodeStateFrame(binaryMessage(message.data)))

        expect(stateFrames).toHaveLength(20)
        expect(stateFrames.every((frame) => frame.serverTick % 3 === 0)).toBe(true)
        expect(stateFrames.every((frame) => frame.worldHash === null)).toBe(true)

        await waitForCompletedHash(room)
        const [ hashedMessage ] = await collectMessages(socket, 1, async () =>
        {
            await runInDurableObject(stub, async (instance) =>
            {
                const probe = runtimeProbe(instance)
                for(let tick = 0; tick < 3; tick++)
                    probe.advanceOneTick()
            })
        })
        const hashedFrame = decodeStateFrame(binaryMessage(hashedMessage.data))
        expect(hashedFrame.worldHash).not.toBeNull()
        expect(hashedFrame.worldHash!.hashTick % 60).toBe(0)
        expect(hashedFrame.worldHash!.hashTick).toBeLessThan(hashedFrame.serverTick)
        expect(hashedFrame.worldHash!.sha256).toHaveLength(32)

        await runInDurableObject(stub, async (instance, state) =>
        {
            const probe = runtimeProbe(instance)
            const serverSocket = state.getWebSockets().find((candidate) =>
            {
                const attachment = candidate.deserializeAttachment() as SessionAttachment | null
                return attachment?.handshake === 'session_active'
                    && attachment.playerId === grant.playerId
                    && attachment.generation === 1
            })

            expect(serverSocket).toBeDefined()
            probe.webSocketClose(serverSocket!, 1000, 'test disconnect', true)

            for(let tick = 0; tick < 180; tick++)
                probe.advanceOneTick()

            expect(probe.sessions.size).toBe(0)
            expect(probe.scheduler.running).toBe(false)
            expect(probe.simulation).toBeNull()
            expect(probe.authoritativeWorld).toBeNull()
        })

        await evictDurableObject(stub, { webSockets: 'close' })
    })
})
