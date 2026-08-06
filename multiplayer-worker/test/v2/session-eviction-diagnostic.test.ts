import {
    SELF,
    evictDurableObject,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import {
    decodeErrorFrame,
    decodeResume,
    encodeHello,
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
                timeout = setTimeout(
                    () => reject(new Error(`stage timeout: ${label}`)),
                    1000,
                )
            }),
        ])
    }
    finally
    {
        if(timeout !== undefined)
            clearTimeout(timeout)
    }
}

test('diagnoses eviction while an authoritative room timer is active', async () =>
{
    const room = `active-eviction-${crypto.randomUUID()}`
    const response = await stage('upgrade', SELF.fetch(
        `https://worker.test/ws?room=${encodeURIComponent(room)}&protocol=2`,
        { headers: { Upgrade: 'websocket' } },
    ))
    const socket = response.webSocket!
    socket.binaryType = 'arraybuffer'
    socket.accept()

    expect(decodeErrorFrame(binary((await stage('hello-required', message(socket))).data)).message)
        .toBe('HELLO_REQUIRED')

    const grantFrame = message(socket)
    socket.send(encodeHello({ clientTick: 1 }))
    expect(decodeResume(binary((await stage('session-grant', grantFrame)).data)).playerId)
        .toBeGreaterThan(0)

    const stub = env.AUTHORITATIVE_ROOM.getByName(room)
    await stage('active-room-eviction', evictDurableObject(stub, { webSockets: 'close' }))
})
