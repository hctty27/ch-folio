import { SELF } from 'cloudflare:test'
import {
    decodeErrorFrame,
    decodeResume,
    encodeHello,
    encodeResume,
} from '@ch-folio/authoritative-physics'
import { expect, test } from 'vitest'

function binary(data: unknown): ArrayBuffer
{
    if(data instanceof ArrayBuffer)
        return data
    if(ArrayBuffer.isView(data))
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    throw new TypeError('expected binary message')
}

function message(socket: WebSocket): Promise<MessageEvent>
{
    return new Promise((resolve, reject) =>
    {
        socket.addEventListener('message', resolve, { once: true })
        socket.addEventListener('error', () => reject(new Error('socket error')), { once: true })
    })
}

async function stage<T>(label: string, promise: Promise<T>): Promise<T>
{
    let timeout: ReturnType<typeof setTimeout> | undefined
    try
    {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) =>
            {
                timeout = setTimeout(() => reject(new Error(`stage timeout: ${label}`)), 750)
            }),
        ])
    }
    finally
    {
        if(timeout !== undefined)
            clearTimeout(timeout)
    }
}

async function open(room: string): Promise<WebSocket>
{
    const response = await stage('upgrade', SELF.fetch(
        `https://worker.test/ws?room=${encodeURIComponent(room)}&protocol=2`,
        { headers: { Upgrade: 'websocket' } },
    ))
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    socket.binaryType = 'arraybuffer'
    socket.accept()
    const required = decodeErrorFrame(binary((await stage('hello-required', message(socket))).data))
    expect(required.message).toBe('HELLO_REQUIRED')
    return socket
}

async function clientClose(label: string, socket: WebSocket): Promise<void>
{
    const closed = new Promise<void>((resolve) =>
    {
        socket.addEventListener('close', () => resolve(), { once: true })
    })
    socket.close(1000, label)
    await stage(`${label}-close-event`, closed)
}

test('diagnoses every authoritative session websocket stage', async () =>
{
    const room = `diagnostic-${crypto.randomUUID()}`
    const first = await open(room)
    const firstFrame = message(first)
    first.send(encodeHello({ clientTick: 1 }))
    const firstGrant = decodeResume(binary((await stage('first-grant', firstFrame)).data))
    await clientClose('first', first)

    const resumed = await open(room)
    const resumedFrame = message(resumed)
    resumed.send(encodeResume({
        playerId: firstGrant.playerId,
        lastServerTick: firstGrant.lastServerTick,
        resumeToken: firstGrant.resumeToken,
    }))
    const rotated = decodeResume(binary((await stage('rotated-grant', resumedFrame)).data))
    await clientClose('resumed', resumed)

    const stale = await open(room)
    const rejectedFrame = message(stale)
    const staleClosed = new Promise<void>((resolve) =>
    {
        stale.addEventListener('close', () => resolve(), { once: true })
    })
    stale.send(encodeResume({
        playerId: firstGrant.playerId,
        lastServerTick: firstGrant.lastServerTick,
        resumeToken: firstGrant.resumeToken,
    }))
    const rejected = decodeErrorFrame(binary((await stage('stale-rejection', rejectedFrame)).data))
    expect(rejected.message).toBe('INVALID_RESUME')
    await stage('stale-server-close-event', staleClosed)

    const current = await open(room)
    const currentFrame = message(current)
    current.send(encodeResume({
        playerId: rotated.playerId,
        lastServerTick: rotated.lastServerTick,
        resumeToken: rotated.resumeToken,
    }))
    decodeResume(binary((await stage('current-grant', currentFrame)).data))
    await clientClose('current', current)
})
