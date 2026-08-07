import http from 'node:http'
import { WebSocketServer } from 'ws'
import { RAPIER_VERSION, VERSIONS } from '@ch-folio/authoritative-physics'
import { RoomRegistry } from './RoomRegistry.js'
import { normalizeRoomName } from './roomName.js'

const HEALTH_PATH = '/healthz'
const WEBSOCKET_PATH = '/ws'
const HEALTH_CACHE_CONTROL = 'no-store'
const HEALTH_CONTENT_TYPE = 'application/json; charset=utf-8'
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
export const WEBSOCKET_LIMITS = Object.freeze({
    maxPayload: 64 * 1024,
    maxFragments: 64,
    maxBufferedChunks: 128,
})

function sendJson(response, statusCode, body)
{
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    response.writeHead(statusCode, {
        'content-type': HEALTH_CONTENT_TYPE,
        'cache-control': HEALTH_CACHE_CONTROL,
        'content-length': payload.byteLength,
    })
    response.end(payload)
}

function rejectUpgrade(socket, statusCode, message)
{
    const body = Buffer.from(`${message}\n`, 'utf8')
    socket.end(
        `HTTP/1.1 ${statusCode} ${message}\r\n`
        + 'Connection: close\r\n'
        + 'Cache-Control: no-store\r\n'
        + 'Content-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${body.byteLength}\r\n`
        + '\r\n'
        + body.toString('utf8'),
    )
}

function activeSocketCount(registry)
{
    let total = 0
    for(const room of registry.values())
        total += room.activeSocketCount
    return total
}

export function createAuthoritativeServer({
    host = '127.0.0.1',
    port = 8080,
    benchmarkToken = null,
    roomFactory,
    roomOptions = {},
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
} = {})
{
    const startedAt = Date.now()
    let stopping = false
    let heartbeat = null
    const registry = new RoomRegistry({
        roomFactory,
        roomOptions: {
            ...roomOptions,
            benchmarkToken,
        },
    })
    const webSockets = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: WEBSOCKET_LIMITS.maxPayload,
    })
    const server = http.createServer((request, response) =>
    {
        let url
        try
        {
            url = new URL(request.url ?? '/', 'http://authoritative-node.invalid')
        }
        catch
        {
            response.writeHead(400).end()
            return
        }

        if(request.method !== 'GET' || url.pathname !== HEALTH_PATH)
        {
            response.writeHead(404, { 'cache-control': HEALTH_CACHE_CONTROL }).end()
            return
        }

        sendJson(response, 200, {
            ok: true,
            protocolVersion: VERSIONS.protocolVersion,
            vehiclePhysicsVersion: VERSIONS.vehiclePhysicsVersion,
            mapCollisionVersion: VERSIONS.mapCollisionVersion,
            rapierVersion: RAPIER_VERSION,
            nodeVersion: process.version,
            uptimeSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
            roomCount: registry.size,
            activeSocketCount: activeSocketCount(registry),
        })
    })

    server.on('upgrade', (request, socket, head) =>
    {
        if(stopping)
        {
            rejectUpgrade(socket, 503, 'Service Unavailable')
            return
        }

        let url
        try
        {
            url = new URL(request.url ?? '/', 'http://authoritative-node.invalid')
        }
        catch
        {
            rejectUpgrade(socket, 400, 'Bad Request')
            return
        }

        if(url.pathname !== WEBSOCKET_PATH)
        {
            rejectUpgrade(socket, 404, 'Not Found')
            return
        }
        if(url.searchParams.get('protocol') !== String(VERSIONS.protocolVersion))
        {
            rejectUpgrade(socket, 426, 'Upgrade Required')
            return
        }

        const roomName = normalizeRoomName(url.searchParams.get('room'))
        if(roomName === null)
        {
            rejectUpgrade(socket, 400, 'Bad Request')
            return
        }

        webSockets.handleUpgrade(request, socket, head, (webSocket) =>
        {
            const room = registry.getOrCreate(roomName)
            room.attachSocket(webSocket)
        })
    })

    if(heartbeatIntervalMs > 0)
    {
        webSockets.on('connection', (socket) =>
        {
            socket.isAlive = true
            socket.on('pong', () =>
            {
                socket.isAlive = true
            })
        })
    }

    function startHeartbeat()
    {
        if(heartbeatIntervalMs <= 0 || heartbeat !== null)
            return
        heartbeat = setInterval(() =>
        {
            for(const socket of webSockets.clients)
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
        heartbeat.unref?.()
    }

    function stopHeartbeat()
    {
        if(heartbeat === null)
            return
        clearInterval(heartbeat)
        heartbeat = null
    }

    return {
        registry,
        async start()
        {
            if(server.listening)
                return this.address()
            stopping = false
            await new Promise((resolve, reject) =>
            {
                const onError = (error) =>
                {
                    server.off('listening', onListening)
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
            startHeartbeat()
            return this.address()
        },
        async stop()
        {
            if(stopping)
                return
            stopping = true
            stopHeartbeat()
            await registry.stop()
            for(const socket of webSockets.clients)
                socket.terminate()
            await new Promise((resolve, reject) =>
            {
                if(!server.listening)
                {
                    resolve()
                    return
                }
                server.close((error) => error ? reject(error) : resolve())
            })
        },
        address()
        {
            const address = server.address()
            if(address === null || typeof address === 'string')
                return null
            return address
        },
    }
}