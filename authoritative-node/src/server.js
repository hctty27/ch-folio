import http from 'node:http'
import { RAPIER_VERSION, VERSIONS } from '@ch-folio/authoritative-physics'
import { WebSocketServer } from 'ws'
import { normalizeRoomName } from './roomName.js'
import { RoomRegistry } from './RoomRegistry.js'

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
    roomFactory,
    roomOptions = {},
    heartbeatIntervalMs = 30000,
} = {})
{
    const registry = new RoomRegistry({ roomFactory, roomOptions })
    const startedAt = process.hrtime.bigint()
    const webSocketServer = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: 64 * 1024,
    })

    let stopping = false
    let startPromise = null
    let stopPromise = null
    let heartbeatTimer = null

    const server = http.createServer((request, response) =>
    {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if(request.method === 'GET' && url.pathname === '/healthz')
        {
            const uptimeSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9
            writeJson(response, 200, {
                ok: !stopping,
                protocolVersion: VERSIONS.protocolVersion,
                vehiclePhysicsVersion: VERSIONS.vehiclePhysicsVersion,
                mapCollisionVersion: VERSIONS.mapCollisionVersion,
                rapierVersion: RAPIER_VERSION,
                nodeVersion: process.version,
                uptimeSeconds,
                roomCount: registry.size,
                activeSocketCount: registry.activeSocketCount(),
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
        if(url.searchParams.get('protocol') !== String(VERSIONS.protocolVersion))
        {
            rejectUpgrade(socket, 426, 'protocol_2_required')
            return
        }

        const roomName = normalizeRoomName(url.searchParams.get('room'))
        if(roomName === null)
        {
            rejectUpgrade(socket, 400, 'invalid_room')
            return
        }

        webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        {
            webSocket.isAlive = true
            webSocket.on('pong', () => { webSocket.isAlive = true })
            const room = registry.getOrCreate(roomName)
            room.attachSocket(webSocket)
            webSocketServer.emit('connection', webSocket, request, { room: roomName })
        })
    })

    function startHeartbeat()
    {
        if(!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0)
            return
        heartbeatTimer = setInterval(() =>
        {
            for(const socket of webSocketServer.clients)
            {
                if(socket.isAlive === false)
                {
                    socket.terminate()
                    continue
                }
                socket.isAlive = false
                socket.ping()
            }
        }, heartbeatIntervalMs)
        heartbeatTimer.unref?.()
    }

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
                    startHeartbeat()
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
                if(heartbeatTimer !== null)
                {
                    clearInterval(heartbeatTimer)
                    heartbeatTimer = null
                }
                await registry.stop()
                await new Promise((resolve) => webSocketServer.close(() => resolve()))
                if(server.listening)
                {
                    await new Promise((resolve, reject) =>
                    {
                        server.close((error) => error ? reject(error) : resolve())
                    })
                }
            })()
            return stopPromise
        },
    }
}
