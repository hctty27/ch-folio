import { SELF } from 'cloudflare:test'
import {
    decodeErrorFrame,
    encodeHello,
} from '@ch-folio/authoritative-physics'
import { describe, expect, test } from 'vitest'

import {
    MESSAGE_TYPES,
    PROTOCOL_VERSION,
    decodeMessage,
} from '../../src/protocol'

const SUPPORTED_PROTOCOL_VERSIONS = [ 1, 2 ]

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
            reject(new Error('WebSocket emitted an error before its first message'))
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

async function openSocket(url: string): Promise<WebSocket>
{
    const response = await SELF.fetch(url, {
        headers: {
            Upgrade: 'websocket',
        },
    })

    expect(response.status).toBe(101)
    expect(response.webSocket).not.toBeNull()

    const socket = response.webSocket!
    socket.accept()
    return socket
}

describe('protocol routing', () =>
{
    test('keeps missing protocol and explicit protocol=1 on the existing v1 room', async () =>
    {
        for(const suffix of [ '', '&protocol=1' ])
        {
            const socket = await openSocket(`https://worker.test/ws?room=Routing-V1${suffix}`)
            const event = await nextMessage(socket)
            const welcome = decodeMessage(binaryMessage(event.data)) as Record<string, unknown>

            expect(welcome.v).toBe(PROTOCOL_VERSION)
            expect(welcome.t).toBe(MESSAGE_TYPES.WELCOME)
            socket.close(1000, 'done')
        }
    })

    test('routes protocol=2 to an isolated authoritative room that requires binary hello first', async () =>
    {
        const socket = await openSocket('https://worker.test/ws?room=Routing-V2&protocol=2')
        const initial = decodeErrorFrame(binaryMessage((await nextMessage(socket)).data))

        expect(initial).toMatchObject({
            code: 1,
            retryable: true,
            contextTick: 0,
            message: 'HELLO_REQUIRED',
        })

        socket.send(encodeHello({ clientTick: 123 }))
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(socket.readyState).toBe(WebSocket.OPEN)
        socket.close(1000, 'done')
    })

    test('rejects unsupported protocol selectors before entering either room namespace', async () =>
    {
        const response = await SELF.fetch(
            'https://worker.test/ws?room=Routing-Invalid&protocol=3',
            { headers: { Upgrade: 'websocket' } },
        )
        const body = await response.json<{
            ok: boolean
            error: string
            supportedProtocolVersions: number[]
        }>()

        expect(response.status).toBe(400)
        expect(body).toEqual({
            ok: false,
            error: 'unsupported_protocol',
            supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        })
    })

    test('health advertises both supported transport versions', async () =>
    {
        const response = await SELF.fetch('https://worker.test/health')
        const body = await response.json<{
            ok: boolean
            protocolVersion: number
            supportedProtocolVersions: number[]
        }>()

        expect(response.status).toBe(200)
        expect(body.ok).toBe(true)
        expect(body.protocolVersion).toBe(1)
        expect(body.supportedProtocolVersions).toEqual(SUPPORTED_PROTOCOL_VERSIONS)
    })
})
