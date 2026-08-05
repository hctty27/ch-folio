import { RAPIER_VERSION } from '@ch-folio/authoritative-physics'
import RAPIER from '@dimforge/rapier3d'
import { DurableObject } from 'cloudflare:workers'
import {
    MAX_MESSAGE_BYTES,
    MESSAGE_TYPES,
    PROTOCOL_VERSION,
    type PlayerStateMessage,
    type SocketAttachment,
    consumeRateLimit,
    createSocketAttachment,
    decodeMessage,
    encodeMessage,
    getMessageSize,
    normalizeRoom,
    sanitizeClientState,
} from './protocol'
import { runRapierSmoke } from './v2/rapierSmoke'

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value)
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

export default {
    async fetch(request, env): Promise<Response>
    {
        const url = new URL(request.url)

        if(request.method === 'GET' && url.pathname === '/health')
        {
            return json({
                ok: true,
                service: 'ch-folio-multiplayer',
                protocolVersion: PROTOCOL_VERSION,
            })
        }

        if(request.method === 'GET' && url.pathname === '/health/rapier-v2')
        {
            const result = runRapierSmoke(RAPIER)

            return json({
                ok: true,
                rapierVersion: RAPIER_VERSION,
                ...result,
            })
        }

        if(url.pathname !== '/ws')
            return json({ ok: false, error: 'not_found' }, 404)

        if(request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
            return json({ ok: false, error: 'websocket_upgrade_required' }, 426)

        const room = normalizeRoom(url.searchParams.get('room'))
        const stub = env.GAME_ROOM.getByName(room)
        return stub.fetch(request)
    },
} satisfies ExportedHandler<Env>

export class GameRoom extends DurableObject<Env>
{
    async fetch(request: Request): Promise<Response>
    {
        if(request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
            return json({ ok: false, error: 'websocket_upgrade_required' }, 426)

        const now = Date.now()
        const room = normalizeRoom(this.ctx.id.name)
        const playerId = crypto.randomUUID()
        const pair = new WebSocketPair()
        const [ client, server ] = Object.values(pair)
        const attachment = createSocketAttachment(playerId, room, now)

        this.ctx.acceptWebSocket(server)
        server.serializeAttachment(attachment)

        const players = this.ctx.getWebSockets()
            .filter((socket) => socket !== server)
            .map((socket) => this.getAttachment(socket))
            .filter((item) => item.latestState !== null)
            .map((item): PlayerStateMessage => ({
                ...item.latestState!,
                id: item.playerId,
            }))

        server.send(encodeMessage({
            v: PROTOCOL_VERSION,
            t: MESSAGE_TYPES.WELCOME,
            id: playerId,
            ts: now,
            room,
            players,
        }))

        this.broadcast({
            v: PROTOCOL_VERSION,
            t: MESSAGE_TYPES.JOINED,
            id: playerId,
            ts: now,
        }, server)

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void
    {
        if(getMessageSize(message) > MAX_MESSAGE_BYTES)
        {
            this.sendError(socket, 'message_too_large')
            socket.close(1009, 'message too large')
            return
        }

        const now = Date.now()
        let attachment = this.getAttachment(socket)
        const rateLimit = consumeRateLimit(attachment, now)
        attachment = rateLimit.attachment
        socket.serializeAttachment(attachment)

        if(!rateLimit.allowed)
        {
            this.sendError(socket, 'rate_limit_exceeded')
            socket.close(1008, 'rate limit exceeded')
            return
        }

        let decoded: unknown
        try
        {
            decoded = decodeMessage(message)
        }
        catch
        {
            this.sendError(socket, 'invalid_message_encoding')
            return
        }

        if(isRecord(decoded) && decoded.v === PROTOCOL_VERSION && decoded.t === MESSAGE_TYPES.PING)
        {
            socket.send(encodeMessage({
                v: PROTOCOL_VERSION,
                t: MESSAGE_TYPES.PONG,
                ts: now,
            }))
            return
        }

        try
        {
            const state = sanitizeClientState(decoded, now, attachment.lastSequence)
            attachment = {
                ...attachment,
                lastSequence: state.seq,
                latestState: state,
            }
            socket.serializeAttachment(attachment)

            this.broadcast({
                ...state,
                id: attachment.playerId,
            }, socket)
        }
        catch(error)
        {
            this.sendError(
                socket,
                error instanceof Error ? error.message : 'invalid_state',
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
        this.broadcastDeparture(socket)
    }

    webSocketError(socket: WebSocket, error: unknown): void
    {
        console.error('[GameRoom] WebSocket error', error)
        this.broadcastDeparture(socket)
    }

    private getAttachment(socket: WebSocket): SocketAttachment
    {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null
        if(attachment?.playerId)
            return attachment

        const fallback = createSocketAttachment(
            crypto.randomUUID(),
            normalizeRoom(this.ctx.id.name),
            Date.now(),
        )
        socket.serializeAttachment(fallback)
        return fallback
    }

    private broadcastDeparture(socket: WebSocket): void
    {
        const attachment = this.getAttachment(socket)
        this.broadcast({
            v: PROTOCOL_VERSION,
            t: MESSAGE_TYPES.LEFT,
            id: attachment.playerId,
            ts: Date.now(),
        }, socket)
    }

    private sendError(socket: WebSocket, message: string): void
    {
        try
        {
            socket.send(encodeMessage({
                v: PROTOCOL_VERSION,
                t: MESSAGE_TYPES.ERROR,
                message,
                ts: Date.now(),
            }))
        }
        catch(error)
        {
            console.warn('[GameRoom] Unable to send protocol error', error)
        }
    }

    private broadcast(message: unknown, excluded?: WebSocket): void
    {
        const encoded = encodeMessage(message)

        for(const socket of this.ctx.getWebSockets())
        {
            if(socket === excluded || socket.readyState !== WebSocket.OPEN)
                continue

            try
            {
                socket.send(encoded)
            }
            catch(error)
            {
                console.warn('[GameRoom] Unable to broadcast to socket', error)
            }
        }
    }
}
