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
    encodeResume,
} from '@ch-folio/authoritative-physics'
import { describe, expect, test } from 'vitest'

import { AuthoritativeGameRoom } from '../../src/v2/AuthoritativeGameRoom'
import {
    constantTimeEqual,
    createResumeToken,
    digestResumeToken,
    resumeTokenFromBytes,
    resumeTokenToBytes,
} from '../../src/v2/crypto'
import {
    SESSION_GRACE_TICKS,
    SESSION_STATES,
    SessionRegistry,
} from '../../src/v2/SessionRegistry'

type SessionAttachment = {
    handshake?: string
    playerId?: number | null
    generation?: number | null
}

type RuntimeProbe = {
    scheduler: {
        running: boolean
    }
    sessions: {
        size: number
    }
    simulation: unknown | null
    authoritativeWorld: unknown | null
    advanceOneTick(): void
}

function nextMessage(socket: WebSocket): Promise<MessageEvent>
{
    return new Promise((resolve, reject) =>
    {
        const onMessage = (event: MessageEvent): void =>
        {
            socket.removeEventListener('error', onError)
            resolve(event)
        }
        const onError = (): void =>
        {
            socket.removeEventListener('message', onMessage)
            reject(new Error('WebSocket emitted an error before its next message'))
        }

        socket.addEventListener('message', onMessage, { once: true })
        socket.addEventListener('error', onError, { once: true })
    })
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
    expect(required).toMatchObject({
        code: 1,
        retryable: true,
        message: 'HELLO_REQUIRED',
    })

    return socket
}

function findSessionSocket(
    sockets: WebSocket[],
    playerId: number,
    generation: number,
): WebSocket | undefined
{
    return sockets.find((candidate) =>
    {
        const attachment = candidate.deserializeAttachment() as SessionAttachment | null
        return attachment?.handshake === 'session_active'
            && attachment.playerId === playerId
            && attachment.generation === generation
    })
}

async function disconnectSession(
    room: string,
    playerId: number,
    generation: number,
): Promise<void>
{
    const stub = env.AUTHORITATIVE_ROOM.getByName(room)

    await runInDurableObject(stub, async (
        instance: AuthoritativeGameRoom,
        state,
    ) =>
    {
        const socket = findSessionSocket(
            state.getWebSockets(),
            playerId,
            generation,
        )

        expect(socket).toBeDefined()
        instance.webSocketClose(
            socket!,
            1000,
            'test disconnect',
            true,
        )
    })
}

async function disconnectExpireAndEvict(
    room: string,
    playerId: number,
    generation: number,
): Promise<void>
{
    const stub = env.AUTHORITATIVE_ROOM.getByName(room)

    await runInDurableObject(stub, async (
        instance: AuthoritativeGameRoom,
        state,
    ) =>
    {
        const socket = findSessionSocket(
            state.getWebSockets(),
            playerId,
            generation,
        )
        expect(socket).toBeDefined()

        instance.webSocketClose(
            socket!,
            1000,
            'test complete',
            true,
        )

        const probe = instance as unknown as RuntimeProbe
        for(let tick = 0; tick < SESSION_GRACE_TICKS; tick++)
            probe.advanceOneTick()

        expect(probe.sessions.size).toBe(0)
        expect(probe.scheduler.running).toBe(false)
        expect(probe.simulation).toBeNull()
        expect(probe.authoritativeWorld).toBeNull()
    })

    await evictDurableObject(stub, { webSockets: 'close' })
}

describe('resume-token cryptography', () =>
{
    test('creates 256-bit base64url tokens and stable SHA-256 digests', async () =>
    {
        const first = createResumeToken()
        const second = createResumeToken()

        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(second).not.toBe(first)

        const firstBytes = resumeTokenToBytes(first)
        expect(firstBytes).toHaveLength(32)
        expect(resumeTokenFromBytes(firstBytes)).toBe(first)

        const digest = await digestResumeToken(first)
        const sameDigest = await digestResumeToken(first)
        const differentDigest = await digestResumeToken(second)

        expect(digest).toHaveLength(32)
        expect(constantTimeEqual(digest, sameDigest)).toBe(true)
        expect(constantTimeEqual(digest, differentDigest)).toBe(false)
        expect(constantTimeEqual(digest, digest.slice(0, 31))).toBe(false)
    })
})

describe('in-memory session registry', () =>
{
    test('stores only token digests, rotates on resume, and invalidates stale generations', async () =>
    {
        const registry = new SessionRegistry()
        const created = await registry.createSession({
            room: 'secure-room',
            currentTick: 5,
        })

        expect(created).not.toBeNull()
        expect(created).toMatchObject({
            entityOrder: 1,
            state: SESSION_STATES.SYNCING,
            generation: 1,
        })

        const stored = registry.readSession(created!.playerId)
        expect(stored).not.toBeNull()
        expect(stored).not.toHaveProperty('resumeToken')
        expect(stored!.resumeTokenDigest).toEqual(
            await digestResumeToken(created!.resumeToken),
        )

        expect(registry.setState({
            playerId: created!.playerId,
            generation: created!.generation,
            state: SESSION_STATES.ACTIVE,
        })).toBe(true)
        expect(registry.disconnect({
            playerId: created!.playerId,
            generation: created!.generation,
            currentTick: 20,
        })).toBe(true)

        const resumed = await registry.resumeSession({
            room: 'secure-room',
            playerId: created!.playerId,
            resumeToken: created!.resumeToken,
            currentTick: 21,
        })

        expect(resumed).not.toBeNull()
        expect(resumed).toMatchObject({
            playerId: created!.playerId,
            entityOrder: created!.entityOrder,
            state: SESSION_STATES.ACTIVE,
            generation: 2,
        })
        expect(resumed!.resumeToken).not.toBe(created!.resumeToken)
        expect(registry.isCurrentController(created!.playerId, 1)).toBe(false)
        expect(registry.isCurrentController(created!.playerId, 2)).toBe(true)

        expect(registry.disconnect({
            playerId: created!.playerId,
            generation: 1,
            currentTick: 22,
        })).toBe(false)
        expect(registry.readSession(created!.playerId)?.state).toBe(SESSION_STATES.ACTIVE)

        expect(registry.disconnect({
            playerId: created!.playerId,
            generation: 2,
            currentTick: 30,
        })).toBe(true)
        await expect(registry.resumeSession({
            room: 'secure-room',
            playerId: created!.playerId,
            resumeToken: created!.resumeToken,
            currentTick: 31,
        })).resolves.toBeNull()

        const resumedAgain = await registry.resumeSession({
            room: 'secure-room',
            playerId: created!.playerId,
            resumeToken: resumed!.resumeToken,
            currentTick: 31,
        })
        expect(resumedAgain?.generation).toBe(3)
    })

    test('retains grace for exactly 180 ticks and reuses the lowest released entity order', async () =>
    {
        const registry = new SessionRegistry()
        const sessions = []

        for(let index = 0; index < 8; index++)
        {
            sessions.push(await registry.createSession({
                room: 'full-room',
                currentTick: 0,
            }))
        }

        expect(sessions.map((session) => session?.entityOrder)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8,
        ])
        await expect(registry.createSession({
            room: 'full-room',
            currentTick: 0,
        })).resolves.toBeNull()

        const first = sessions[0]!
        expect(registry.disconnect({
            playerId: first.playerId,
            generation: first.generation,
            currentTick: 0,
        })).toBe(true)
        expect(registry.readSession(first.playerId)?.graceExpiresTick)
            .toBe(SESSION_GRACE_TICKS)
        expect(registry.expireGrace(SESSION_GRACE_TICKS - 1)).toEqual([])
        expect(registry.readSession(first.playerId)).not.toBeNull()

        const expired = registry.expireGrace(SESSION_GRACE_TICKS)
        expect(expired).toHaveLength(1)
        expect(expired[0].playerId).toBe(first.playerId)
        expect(registry.readSession(first.playerId)).toBeNull()

        const replacement = await registry.createSession({
            room: 'full-room',
            currentTick: SESSION_GRACE_TICKS,
        })
        expect(replacement?.entityOrder).toBe(1)
    })
})

describe('authoritative room session handshake', () =>
{
    test('grants digest-backed credentials and rotates them on a short resume', async () =>
    {
        const room = `session-${crypto.randomUUID()}`
        const firstSocket = await openSocket(room)
        const firstGrantMessage = nextMessage(firstSocket)
        firstSocket.send(encodeHello({ clientTick: 10 }))
        const firstGrant = decodeResume(binaryMessage((await firstGrantMessage).data))

        expect(firstGrant.playerId).toBeGreaterThan(0)
        expect(firstGrant.resumeToken).toHaveLength(32)
        await disconnectSession(room, firstGrant.playerId, 1)

        const resumedSocket = await openSocket(room)
        const rotatedMessage = nextMessage(resumedSocket)
        resumedSocket.send(encodeResume({
            playerId: firstGrant.playerId,
            lastServerTick: firstGrant.lastServerTick,
            resumeToken: firstGrant.resumeToken,
        }))
        const rotated = decodeResume(binaryMessage((await rotatedMessage).data))

        expect(rotated.playerId).toBe(firstGrant.playerId)
        expect(rotated.resumeToken).not.toEqual(firstGrant.resumeToken)
        await disconnectSession(room, firstGrant.playerId, 2)

        const staleSocket = await openSocket(room)
        const rejectedMessage = nextMessage(staleSocket)
        staleSocket.send(encodeResume({
            playerId: firstGrant.playerId,
            lastServerTick: firstGrant.lastServerTick,
            resumeToken: firstGrant.resumeToken,
        }))
        const rejected = decodeErrorFrame(binaryMessage((await rejectedMessage).data))
        expect(rejected).toMatchObject({
            retryable: false,
            message: 'INVALID_RESUME',
        })

        const currentSocket = await openSocket(room)
        const currentMessage = nextMessage(currentSocket)
        currentSocket.send(encodeResume({
            playerId: rotated.playerId,
            lastServerTick: rotated.lastServerTick,
            resumeToken: rotated.resumeToken,
        }))
        const current = decodeResume(binaryMessage((await currentMessage).data))
        expect(current.playerId).toBe(firstGrant.playerId)
        expect(current.resumeToken).not.toEqual(rotated.resumeToken)

        await disconnectExpireAndEvict(room, firstGrant.playerId, 3)
    })
})
