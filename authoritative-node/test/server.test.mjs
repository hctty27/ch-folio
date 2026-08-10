import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { WebSocket } from 'ws'
import { readServerConfig } from '../src/config.js'
import { normalizeRoomName } from '../src/roomName.js'
import {
    WEBSOCKET_LIMITS,
    createAuthoritativeServer,
} from '../src/server.js'

function requestJson(port, path)
{
    return new Promise((resolve, reject) =>
    {
        const request = http.get({ host: '127.0.0.1', port, path }, (response) =>
        {
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () =>
            {
                try
                {
                    resolve({
                        statusCode: response.statusCode,
                        headers: response.headers,
                        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                    })
                }
                catch(error)
                {
                    reject(error)
                }
            })
        })
        request.on('error', reject)
    })
}

function connect(url)
{
    return new Promise((resolve) =>
    {
        const socket = new WebSocket(url)
        socket.once('open', () => resolve({ socket, opened: true }))
        socket.once('unexpected-response', (_request, response) =>
        {
            response.resume()
            resolve({ socket, opened: false, statusCode: response.statusCode })
        })
        socket.once('error', () => {})
    })
}

test('room names use the existing lowercase bounded contract', () =>
{
    assert.equal(normalizeRoomName('  Test-Room_01  '), 'test-room_01')
    assert.equal(normalizeRoomName(''), null)
    assert.equal(normalizeRoomName('bad room'), null)
    assert.equal(normalizeRoomName('a'.repeat(65)), null)
})

test('WebSocket parser limits are substantially tighter than library defaults', () =>
{
    assert.deepEqual(WEBSOCKET_LIMITS, {
        maxPayload: 64 * 1024,
        maxFragments: 64,
        maxBufferedChunks: 128,
    })
})

test('benchmark token configuration is absent by default and fail-closed when supplied', () =>
{
    assert.equal(readServerConfig({ HOST: '127.0.0.1', PORT: '8080' }).benchmarkToken, null)
    assert.throws(
        () => readServerConfig({ AUTHORITATIVE_BENCHMARK_TOKEN: 'short' }),
        /at least 32 characters/u,
    )
    const benchmarkToken = 'benchmark-token-0123456789-abcdef'
    assert.equal(
        readServerConfig({ AUTHORITATIVE_BENCHMARK_TOKEN: benchmarkToken }).benchmarkToken,
        benchmarkToken,
    )
})

test('health endpoint is bounded, non-cacheable, and omits room internals and benchmark secrets', async (t) =>
{
    const benchmarkToken = 'benchmark-token-0123456789-abcdef'
    const service = createAuthoritativeServer({
        host: '127.0.0.1',
        port: 0,
        benchmarkToken,
    })
    await service.start()
    t.after(() => service.stop())

    const address = service.address()
    const response = await requestJson(address.port, '/healthz')
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.body.ok, true)
    assert.equal(response.body.protocolVersion, 2)
    assert.equal(response.body.roomCount, 0)
    assert.equal(response.body.activeSocketCount, 0)
    assert.equal(typeof response.body.uptimeSeconds, 'number')
    assert.equal('rooms' in response.body, false)
    assert.equal('tokens' in response.body, false)
    assert.equal(JSON.stringify(response.body).includes(benchmarkToken), false)
})

test('WebSocket upgrade requires exact path, protocol 2, and normalized room', async (t) =>
{
    const service = createAuthoritativeServer({ host: '127.0.0.1', port: 0 })
    await service.start()
    t.after(() => service.stop())
    const { port } = service.address()

    const wrongPath = await connect(`ws://127.0.0.1:${port}/other?room=test&protocol=2`)
    assert.equal(wrongPath.opened, false)
    assert.equal(wrongPath.statusCode, 404)

    const wrongProtocol = await connect(`ws://127.0.0.1:${port}/ws?room=test&protocol=1`)
    assert.equal(wrongProtocol.opened, false)
    assert.equal(wrongProtocol.statusCode, 426)

    const invalidRoom = await connect(`ws://127.0.0.1:${port}/ws?room=bad%20room&protocol=2`)
    assert.equal(invalidRoom.opened, false)
    assert.equal(invalidRoom.statusCode, 400)

    const accepted = await connect(`ws://127.0.0.1:${port}/ws?room=%20TeSt-Room_01%20&protocol=2`)
    assert.equal(accepted.opened, true)
    assert.equal(service.registry.has('test-room_01'), true)
    accepted.socket.close()
})

test('stop is idempotent and rejects new connections', async () =>
{
    const service = createAuthoritativeServer({ host: '127.0.0.1', port: 0 })
    await service.start()
    const { port } = service.address()
    await service.stop()
    await service.stop()
    await assert.rejects(requestJson(port, '/healthz'))
})