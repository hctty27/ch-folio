import http from 'node:http'
import { RAPIER_VERSION, VERSIONS } from '@ch-folio/authoritative-physics'
import { WebSocketServer } from 'ws'
import { normalizeRoomName } from './roomName.js'

const JSON_HEADERS = Object.freeze({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
})

function writeJson(response, statusCode, value)
{
    const body = JSON.stringify(value)
    response.writeHead(statusCode, {
        ...JSON_HEADERS,
        'content-length': Buffer.byteLength(body),
    })
    response.end(body)
}

function rejectUpgrade(socket, statusCode, message)
{
    if(socket.destroyed)
        return

    const body = JSON.stringify({ ok: false, error: message })
    socket.end(
        `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] ?? 'Error'}\r\n`
        + 'Connection: close\r\n'
        + 'Cache-Control: no-store\r\n'
        + 'Content-Type: application/json; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + '\r\n'
        + body,
    )
}

export function createAuthoritativeServer({
    host = '127.0.0.1',
    port = 8080,
} = {})
{
    const registry = new Map()
    const sockets = new Set()
    const startedAt = process.hrtime.bigint()
    const webSocketServer = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: 64 * 1024,
    })

    let stopping = false
    let startPromise = null
    let stopPromise = null

    const server = http.createServer((request, response) =>
    {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if(request.method === 'GET' && url.pathname === '/healthz')
        {
            const uptimeSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9
            writeJson(response, 200, {
                ok: !stopping,
                protocolVersion: VERSIONS.protocol,
                vehiclePhysicsVersion: VERSIONS.vehiclePhysics,
                mapCollisionVersion: VERSIONS.mapCollision,
                rapierVersion: RAPIER_VERSION,
                nodeVersion: process.version,
                uptimeSeconds,
                roomCount: registry.size,
                activeSocketCount: sockets.size,
            })
            return
        }

        writeJson(response, 404, { ok: false, error: 'not_found' })
    })

    server.on('upgrade', (request, socket, head) =>
    {
        if(stopping)
        {
            rejectUpgrade(socket, 503, 'server_stopping')
            return
        }

        let url
        try
        {
            url = new URL(request.url ?? '/', 'http://localhost')
        }
        catch
        {
            rejectUpgrade(socket, 400, 'invalid_url')
            return
        }

        if(url.pathname !== '/ws')
        {
            rejectUpgrade(socket, 404, 'not_found')
            return
        }

        if(url.searchParams.get('protocol') !== String(VERSIONS.protocol))
        {
            rejectUpgrade(socket, 426, 'protocol_2_required')
            return
        }

        const room = normalizeRoomName(url.searchParams.get('room'))
        if(room === null)
        {
            rejectUpgrade(socket, 400, 'invalid_room')
            return
        }

        webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        {
            let roomSockets = registry.get(room)
            if(roomSockets === undefined)
            {
                roomSockets = new Set()
                registry.set(room, roomSockets)
            }

            sockets.add(webSocket)
            roomSockets.add(webSocket)
            webSocket.once('close', () =>
            {
                sockets.delete(webSocket)
                roomSockets.delete(webSocket)
                if(roomSockets.size === 0)
                    registry.delete(room)
            })
            webSocket.on('error', () => {})
            webSocketServer.emit('connection', webSocket, request, { room })
        })
    })

    return {
        registry,
        async start()
        {
            if(startPromise !== null)
                return startPromise
            if(stopping)
                throw new Error('server is stopping')

            startPromise = new Promise((resolve, reject) =>
            {
                const onError = (error) =>
                {
                    server.off('listening', onListening)
                    startPromise = null
                    reject(error)
                }
                const onListening = () =>
                {
                    server.off('error', onError)
                    resolve()
                }
                server.once('error', onError)
                server.once('listening', onListening)
                server.listen(port, host)
            })
            return startPromise
        },
        address()
        {
            const address = server.address()
            if(address === null || typeof address === 'string')
                throw new Error('server is not listening on a TCP address')
            return address
        },
        async stop()
        {
            if(stopPromise !== null)
                return stopPromise

            stopping = true
            stopPromise = (async () =>
            {
                for(const socket of sockets)
                    socket.close(1001, 'server_shutdown')

                await new Promise((resolve) =>
                {
                    webSocketServer.close(() => resolve())
                })

                if(!server.listening)
                    return

                await new Promise((resolve, reject) =>
                {
                    server.close((error) => error ? reject(error) : resolve())
                })
                registry.clear()
                sockets.clear()
            })()
            return stopPromise
        },
    }
}
