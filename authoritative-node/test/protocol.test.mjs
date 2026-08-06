import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocket } from 'ws'
import {
    FRAME_TYPES,
    ROOM_SLOT_STATES,
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeResume,
    decodeStateFrame,
    encodeFullSyncRequest,
    encodeHello,
    encodeInputBatch,
    encodeResume,
    encodeSyncReady,
    quantizeInput,
} from '@ch-folio/authoritative-physics'
import { createAuthoritativeServer } from '../src/server.js'

const TEST_TIMEOUT_MS = 2000

function withTimeout(promise, label, timeoutMs = TEST_TIMEOUT_MS)
{
    let timer
    const timeout = new Promise((_, reject) =>
    {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    return Promise.race([ promise, timeout ]).finally(() => clearTimeout(timer))
}

class FrameCollector
{
    constructor(socket)
    {
        this.frames = []
        this.waiters = []
        socket.on('message', (data, isBinary) =>
        {
            const entry = { data: Uint8Array.from(data), isBinary }
            const waiter = this.waiters.shift()
            if(waiter)
            {
                clearTimeout(waiter.timer)
                waiter.resolve(entry)
            }
            else
                this.frames.push(entry)
        })
        socket.on('error', (error) =>
        {
            const waiter = this.waiters.shift()
            if(waiter)
            {
                clearTimeout(waiter.timer)
                waiter.reject(error)
            }
        })
    }

    next(timeoutMs = TEST_TIMEOUT_MS)
    {
        if(this.frames.length > 0)
            return Promise.resolve(this.frames.shift())

        return new Promise((resolve, reject) =>
        {
            const waiter = { resolve, reject, timer: null }
            waiter.timer = setTimeout(() =>
            {
                const index = this.waiters.indexOf(waiter)
                if(index >= 0)
                    this.waiters.splice(index, 1)
                reject(new Error(`binary frame timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            this.waiters.push(waiter)
        })
    }

    async nextType(frameType, attempts = 20)
    {
        for(let index = 0; index < attempts; index++)
        {
            const frame = await this.next()
            if(frame.data[0] === frameType)
                return frame.data
        }
        throw new Error(`frame type ${frameType} not received`)
    }
}

async function openClient(port, room)
{
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}&protocol=2`)
    const collector = new FrameCollector(socket)
    await withTimeout(new Promise((resolve, reject) =>
    {
        socket.once('open', resolve)
        socket.once('error', reject)
    }), 'WebSocket open')
    const helloRequired = decodeErrorFrame((await collector.next()).data)
    assert.equal(helloRequired.message, 'HELLO_REQUIRED')
    return { socket, collector }
}

async function hello(client, clientTick = 0)
{
    client.socket.send(encodeHello({ clientTick }))
    const grant = decodeResume((await client.collector.next()).data)
    const fullSync = decodeFullSyncFrame((await client.collector.next()).data)
    return { grant, fullSync }
}

async function createTestServer(t)
{
    const service = createAuthoritativeServer({
        host: '127.0.0.1',
        port: 0,
        roomOptions: { autoSchedule: false },
        heartbeatIntervalMs: 0,
    })
    await service.start()
    t.after(() => service.stop())
    return service
}

test('HELLO, sync-ready, input, state, and full-sync request form one binary lifecycle', async (t) =>
{
    const service = await createTestServer(t)
    const { port } = service.address()
    const client = await openClient(port, 'alpha')
    t.after(() => client.socket.terminate())

    const { grant, fullSync } = await hello(client)
    assert.equal(grant.lastServerTick, 0)
    assert.equal(fullSync.serverTick, 0)
    assert.equal(fullSync.entities.length, 1)
    assert.equal(fullSync.entities[0].slotState, ROOM_SLOT_STATES.SYNCING)

    const room = service.registry.get('alpha')
    client.socket.send(encodeSyncReady())
    await room.flushMessages()
    assert.equal(room.simulation.getSlot(1).slotState, ROOM_SLOT_STATES.WAITING_SPAWN)

    const statePromise = client.collector.nextType(FRAME_TYPES.STATE)
    room.advanceOneTick()
    room.advanceOneTick()
    room.advanceOneTick()
    const state = decodeStateFrame(await statePromise)
    assert.equal(state.serverTick, 3)
    assert.equal(state.states.length, 1)
    assert.equal(room.simulation.getSlot(1).slotState, ROOM_SLOT_STATES.ACTIVE)

    const inputTick = room.currentTick + 3
    client.socket.send(encodeInputBatch([ quantizeInput({
        clientTick: inputTick,
        sequence: 9,
        throttle: 1,
        brake: 0,
        steering: 0.25,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    }) ]))
    await room.flushMessages()
    assert.equal(room.simulation.getSlot(1).queuedInputs.has(inputTick), true)

    const syncPromise = client.collector.nextType(FRAME_TYPES.FULL_SYNC)
    client.socket.send(encodeFullSyncRequest())
    decodeFullSyncFrame(await syncPromise)
})

test('one room accepts eight sessions and rejects a ninth without affecting another room', async (t) =>
{
    const service = await createTestServer(t)
    const { port } = service.address()
    const clients = []
    t.after(() => clients.forEach(({ socket }) => socket.terminate()))

    for(let index = 0; index < 8; index++)
    {
        const client = await openClient(port, 'full')
        clients.push(client)
        const result = await hello(client)
        assert.equal(result.fullSync.entities[index].entityOrder, index + 1)
    }

    const ninth = await openClient(port, 'full')
    clients.push(ninth)
    ninth.socket.send(encodeHello({ clientTick: 0 }))
    const error = decodeErrorFrame((await ninth.collector.next()).data)
    assert.equal(error.message, 'ROOM_FULL')

    const isolated = await openClient(port, 'other')
    clients.push(isolated)
    const result = await hello(isolated)
    assert.equal(result.fullSync.entities.length, 1)
    assert.equal(service.registry.size, 2)
})

test('resume rotates credentials before expiry and the room disappears at tick 180', async (t) =>
{
    const service = await createTestServer(t)
    const { port } = service.address()
    const first = await openClient(port, 'resume')
    const { grant } = await hello(first)
    const room = service.registry.get('resume')

    first.socket.close(1000, 'disconnect')
    await withTimeout(new Promise((resolve) => first.socket.once('close', resolve)), 'first close')
    await room.flushMessages()

    for(let tick = 0; tick < 179; tick++)
        room.advanceOneTick()

    const resumedClient = await openClient(port, 'resume')
    t.after(() => resumedClient.socket.terminate())
    resumedClient.socket.send(encodeResume({
        playerId: grant.playerId,
        lastServerTick: room.currentTick,
        resumeToken: grant.resumeToken,
    }))
    const rotated = decodeResume((await resumedClient.collector.next()).data)
    decodeFullSyncFrame((await resumedClient.collector.next()).data)
    assert.equal(rotated.playerId, grant.playerId)
    assert.notDeepEqual(rotated.resumeToken, grant.resumeToken)

    resumedClient.socket.close(1000, 'disconnect again')
    await withTimeout(new Promise((resolve) => resumedClient.socket.once('close', resolve)), 'resumed close')
    await room.flushMessages()
    for(let tick = 0; tick < 180; tick++)
        room.advanceOneTick()
    assert.equal(service.registry.has('resume'), false)
})

test('text and unexpected active-session frames receive controlled protocol errors', async (t) =>
{
    const service = await createTestServer(t)
    const { port } = service.address()
    const textClient = await openClient(port, 'text')
    t.after(() => textClient.socket.terminate())
    textClient.socket.send('not binary')
    const textError = decodeErrorFrame((await textClient.collector.next()).data)
    assert.equal(textError.message, 'INVALID_HANDSHAKE')

    const activeClient = await openClient(port, 'unexpected')
    t.after(() => activeClient.socket.terminate())
    await hello(activeClient)
    activeClient.socket.send(encodeHello({ clientTick: 1 }))
    const activeError = decodeErrorFrame((await activeClient.collector.next()).data)
    assert.equal(activeError.message, 'UNEXPECTED_FRAME')
})
