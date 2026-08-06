import {
    decodeHello,
    decodeResume,
    encodeErrorFrame,
    encodeResume,
} from '@ch-folio/authoritative-physics'
import { DurableObject } from 'cloudflare:workers'
import {
    resumeTokenFromBytes,
    resumeTokenToBytes,
} from './crypto'
import {
    SessionRegistry,
    type SessionGrant,
} from './SessionRegistry'

const HELLO_REQUIRED_CODE = 1
const INVALID_HANDSHAKE_CODE = 2
const UNEXPECTED_FRAME_CODE = 3
const ROOM_FULL_CODE = 4
const INVALID_RESUME_CODE = 5
const STALE_CONNECTION_CODE = 6
const SESSION_FAILURE_CODE = 7

const HELLO_REQUIRED_MESSAGE = 'HELLO_REQUIRED'
const INVALID_HANDSHAKE_MESSAGE = 'INVALID_HANDSHAKE'
const UNEXPECTED_FRAME_MESSAGE = 'UNEXPECTED_FRAME'
const ROOM_FULL_MESSAGE = 'ROOM_FULL'
const INVALID_RESUME_MESSAGE = 'INVALID_RESUME'
const STALE_CONNECTION_MESSAGE = 'STALE_CONNECTION'
const SESSION_FAILURE_MESSAGE = 'SESSION_FAILURE'

type HandshakeState =
    | 'awaiting_handshake'
    | 'processing_handshake'
    | 'session_active'

type AuthoritativeSocketAttachment = {
    protocolVersion: 2
    handshake: HandshakeState
    clientTick: number | null
    playerId: number | null
    entityOrder: number | null
    generation: number | null
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
        handshake: 'awaiting_handshake',
        clientTick: null,
        playerId: null,
        entityOrder: null,
        generation: null,
    }
}

function isUint32(value: unknown): value is number
{
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
}

function isEntityOrder(value: unknown): value is number
{
    return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 8
}

export class AuthoritativeGameRoom extends DurableObject<Env>
{
    private readonly sessions = new SessionRegistry()
    private currentTick = 0

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
            contextTick: this.currentTick,
            message: HELLO_REQUIRED_MESSAGE,
        }))

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    async webSocketMessage(
        socket: WebSocket,
        message: string | ArrayBuffer,
    ): Promise<void>
    {
        const attachment = this.getAttachment(socket)

        if(attachment.handshake === 'processing_handshake')
        {
            this.rejectSocket(
                socket,
                UNEXPECTED_FRAME_CODE,
                UNEXPECTED_FRAME_MESSAGE,
                1008,
            )
            return
        }

        if(attachment.handshake === 'session_active')
        {
            if(
                attachment.playerId === null
                || attachment.generation === null
                || !this.sessions.isCurrentController(
                    attachment.playerId,
                    attachment.generation,
                )
            )
            {
                this.rejectSocket(
                    socket,
                    STALE_CONNECTION_CODE,
                    STALE_CONNECTION_MESSAGE,
                    1008,
                )
                return
            }

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
            this.rejectSocket(
                socket,
                INVALID_HANDSHAKE_CODE,
                INVALID_HANDSHAKE_MESSAGE,
                1003,
            )
            return
        }

        try
        {
            const hello = decodeHello(message)
            socket.serializeAttachment({
                ...attachment,
                handshake: 'processing_handshake',
                clientTick: hello.clientTick,
            } satisfies AuthoritativeSocketAttachment)
            await this.createNewSession(socket, hello.clientTick)
            return
        }
        catch
        {
            // The first binary frame may be RESUME instead of HELLO.
        }

        try
        {
            const resume = decodeResume(message)
            socket.serializeAttachment({
                ...attachment,
                handshake: 'processing_handshake',
            } satisfies AuthoritativeSocketAttachment)
            await this.resumeSession(
                socket,
                resume.playerId,
                resumeTokenFromBytes(resume.resumeToken),
            )
            return
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Invalid handshake frame', error)
            this.rejectSocket(
                socket,
                INVALID_HANDSHAKE_CODE,
                INVALID_HANDSHAKE_MESSAGE,
                1002,
            )
        }
    }

    webSocketClose(
        socket: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
    ): void
    {
        void code
        void reason
        void wasClean
        this.disconnectSocket(socket)
    }

    webSocketError(socket: WebSocket, error: unknown): void
    {
        console.error('[AuthoritativeGameRoom] WebSocket error', error)
        this.disconnectSocket(socket)
    }

    private get room(): string
    {
        return this.ctx.id.name ?? 'public'
    }

    private async createNewSession(socket: WebSocket, clientTick: number): Promise<void>
    {
        let grant: SessionGrant | null
        try
        {
            grant = await this.sessions.createSession({
                room: this.room,
                currentTick: this.currentTick,
            })
        }
        catch(error)
        {
            console.error('[AuthoritativeGameRoom] Unable to create session', error)
            this.rejectSocket(
                socket,
                SESSION_FAILURE_CODE,
                SESSION_FAILURE_MESSAGE,
                1011,
            )
            return
        }

        if(grant === null)
        {
            this.rejectSocket(socket, ROOM_FULL_CODE, ROOM_FULL_MESSAGE, 1008)
            return
        }

        const attachment: AuthoritativeSocketAttachment = {
            protocolVersion: 2,
            handshake: 'session_active',
            clientTick,
            playerId: grant.playerId,
            entityOrder: grant.entityOrder,
            generation: grant.generation,
        }
        socket.serializeAttachment(attachment)

        if(!this.sendSessionGrant(socket, grant))
            this.sessions.release({
                playerId: grant.playerId,
                generation: grant.generation,
            })
    }

    private async resumeSession(
        socket: WebSocket,
        playerId: number,
        resumeToken: string,
    ): Promise<void>
    {
        let grant: SessionGrant | null
        try
        {
            grant = await this.sessions.resumeSession({
                room: this.room,
                playerId,
                resumeToken,
                currentTick: this.currentTick,
            })
        }
        catch(error)
        {
            console.error('[AuthoritativeGameRoom] Unable to resume session', error)
            this.rejectSocket(
                socket,
                SESSION_FAILURE_CODE,
                SESSION_FAILURE_MESSAGE,
                1011,
            )
            return
        }

        if(grant === null)
        {
            this.rejectSocket(
                socket,
                INVALID_RESUME_CODE,
                INVALID_RESUME_MESSAGE,
                1008,
            )
            return
        }

        socket.serializeAttachment({
            protocolVersion: 2,
            handshake: 'session_active',
            clientTick: null,
            playerId: grant.playerId,
            entityOrder: grant.entityOrder,
            generation: grant.generation,
        } satisfies AuthoritativeSocketAttachment)

        if(!this.sendSessionGrant(socket, grant))
        {
            this.sessions.release({
                playerId: grant.playerId,
                generation: grant.generation,
            })
            return
        }

        this.invalidateOlderConnections(socket, grant)
    }

    private sendSessionGrant(socket: WebSocket, grant: SessionGrant): boolean
    {
        try
        {
            socket.send(encodeResume({
                playerId: grant.playerId,
                lastServerTick: this.currentTick,
                resumeToken: resumeTokenToBytes(grant.resumeToken),
            }))
            return true
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Unable to send session grant', error)
            try
            {
                socket.close(1011, 'session grant failed')
            }
            catch
            {
                // The socket may already be closed.
            }
            return false
        }
    }

    private invalidateOlderConnections(
        currentSocket: WebSocket,
        grant: SessionGrant,
    ): void
    {
        for(const socket of this.ctx.getWebSockets())
        {
            if(socket === currentSocket)
                continue

            const attachment = this.readAttachment(socket)
            if(
                attachment?.handshake !== 'session_active'
                || attachment.playerId !== grant.playerId
                || attachment.generation === null
                || attachment.generation >= grant.generation
            )
                continue

            this.rejectSocket(
                socket,
                STALE_CONNECTION_CODE,
                STALE_CONNECTION_MESSAGE,
                1008,
            )
        }
    }

    private disconnectSocket(socket: WebSocket): void
    {
        const attachment = this.readAttachment(socket)
        if(
            attachment?.handshake !== 'session_active'
            || attachment.playerId === null
            || attachment.generation === null
        )
            return

        this.sessions.disconnect({
            playerId: attachment.playerId,
            generation: attachment.generation,
            currentTick: this.currentTick,
        })
    }

    private getAttachment(socket: WebSocket): AuthoritativeSocketAttachment
    {
        const attachment = this.readAttachment(socket)
        if(attachment !== null)
            return attachment

        const fallback = createAttachment()
        socket.serializeAttachment(fallback)
        return fallback
    }

    private readAttachment(socket: WebSocket): AuthoritativeSocketAttachment | null
    {
        const attachment = socket.deserializeAttachment() as AuthoritativeSocketAttachment | null
        if(attachment?.protocolVersion !== 2)
            return null

        if(
            attachment.handshake === 'awaiting_handshake'
            || attachment.handshake === 'processing_handshake'
        )
        {
            return attachment.playerId === null
                && attachment.entityOrder === null
                && attachment.generation === null
                ? attachment
                : null
        }

        if(
            attachment.handshake === 'session_active'
            && isUint32(attachment.playerId)
            && attachment.playerId > 0
            && isEntityOrder(attachment.entityOrder)
            && isUint32(attachment.generation)
            && attachment.generation > 0
            && (attachment.clientTick === null || isUint32(attachment.clientTick))
        )
            return attachment

        return null
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
                contextTick: this.currentTick,
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
