import {
    decodeHello,
    encodeErrorFrame,
} from '@ch-folio/authoritative-physics'
import { DurableObject } from 'cloudflare:workers'

const HELLO_REQUIRED_CODE = 1
const INVALID_HELLO_CODE = 2
const UNEXPECTED_FRAME_CODE = 3

const HELLO_REQUIRED_MESSAGE = 'HELLO_REQUIRED'
const INVALID_HELLO_MESSAGE = 'INVALID_HELLO'
const UNEXPECTED_FRAME_MESSAGE = 'UNEXPECTED_FRAME'

type HandshakeState = 'awaiting_hello' | 'hello_received'

type AuthoritativeSocketAttachment = {
    protocolVersion: 2
    handshake: HandshakeState
    clientTick: number | null
}

function json(data: unknown, status = 200): Response
{
    return Response.json(data, {
        status,
        headers: {
            'cache-control': 'no-store',
        },
    })
}

function createAttachment(): AuthoritativeSocketAttachment
{
    return {
        protocolVersion: 2,
        handshake: 'awaiting_hello',
        clientTick: null,
    }
}

export class AuthoritativeGameRoom extends DurableObject<Env>
{
    async fetch(request: Request): Promise<Response>
    {
        if(request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
            return json({ ok: false, error: 'websocket_upgrade_required' }, 426)

        const pair = new WebSocketPair()
        const [ client, server ] = Object.values(pair)
        const attachment = createAttachment()

        this.ctx.acceptWebSocket(server)
        server.serializeAttachment(attachment)
        server.send(encodeErrorFrame({
            code: HELLO_REQUIRED_CODE,
            retryable: true,
            contextTick: 0,
            message: HELLO_REQUIRED_MESSAGE,
        }))

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void
    {
        const attachment = this.getAttachment(socket)

        if(attachment.handshake === 'hello_received')
        {
            this.rejectSocket(
                socket,
                UNEXPECTED_FRAME_CODE,
                UNEXPECTED_FRAME_MESSAGE,
                1008,
            )
            return
        }

        if(typeof message === 'string')
        {
            this.rejectSocket(socket, INVALID_HELLO_CODE, INVALID_HELLO_MESSAGE, 1003)
            return
        }

        try
        {
            const hello = decodeHello(message)
            socket.serializeAttachment({
                protocolVersion: 2,
                handshake: 'hello_received',
                clientTick: hello.clientTick,
            } satisfies AuthoritativeSocketAttachment)
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Invalid HELLO frame', error)
            this.rejectSocket(socket, INVALID_HELLO_CODE, INVALID_HELLO_MESSAGE, 1002)
        }
    }

    webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
    ): void
    {
        void socket
        void code
        void reason
        void wasClean
    }

    webSocketError(socket: WebSocket, error: unknown): void
    {
        void socket
        console.error('[AuthoritativeGameRoom] WebSocket error', error)
    }

    private getAttachment(socket: WebSocket): AuthoritativeSocketAttachment
    {
        const attachment = socket.deserializeAttachment() as AuthoritativeSocketAttachment | null
        if(
            attachment?.protocolVersion === 2
            && (attachment.handshake === 'awaiting_hello' || attachment.handshake === 'hello_received')
        )
            return attachment

        const fallback = createAttachment()
        socket.serializeAttachment(fallback)
        return fallback
    }

    private rejectSocket(
        socket: WebSocket,
        code: number,
        message: string,
        closeCode: number,
    ): void
    {
        try
        {
            socket.send(encodeErrorFrame({
                code,
                retryable: false,
                contextTick: 0,
                message,
            }))
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to send protocol error', error)
        }

        try
        {
            socket.close(closeCode, message.toLowerCase().replaceAll('_', ' '))
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to close rejected socket', error)
        }
    }
}
