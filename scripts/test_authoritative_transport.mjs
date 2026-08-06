import assert from 'node:assert/strict'
import test from 'node:test'

import {
    FRAME_TYPES,
    decodeHello,
    decodeInputBatch,
    decodeResume,
    encodeErrorFrame,
} from '@ch-folio/authoritative-physics'
import { InputPublisher } from '../sources/Game/MultiplayerV2/InputPublisher.js'
import { Server } from '../sources/Game/MultiplayerV2/Server.js'

class FakeSocket
{
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    static instances = []

    constructor(url)
    {
        this.url = String(url)
        this.readyState = FakeSocket.CONNECTING
        this.binaryType = 'blob'
        this.listeners = new Map()
        this.sent = []
        this.closeCalls = []
        FakeSocket.instances.push(this)
    }

    addEventListener(name, callback)
    {
        const listeners = this.listeners.get(name) ?? []
        listeners.push(callback)
        this.listeners.set(name, listeners)
    }

    emit(name, value = {})
    {
        for(const callback of this.listeners.get(name) ?? [])
            callback(value)
    }

    open()
    {
        this.readyState = FakeSocket.OPEN
        this.emit('open')
    }

    receive(data)
    {
        this.emit('message', { data })
    }

    send(frame)
    {
        if(this.readyState !== FakeSocket.OPEN)
            throw new Error('socket is not open')
        this.sent.push(frame)
    }

    close(code = 1000, reason = '')
    {
        if(this.readyState >= FakeSocket.CLOSING)
            return
        this.closeCalls.push({ code, reason })
        this.readyState = FakeSocket.CLOSED
        this.emit('close', { code, reason, wasClean: code === 1000 })
    }
}

class FakeTimers
{
    constructor()
    {
        this.nextId = 1
        this.tasks = new Map()
        this.delays = []
    }

    setTimeout(callback, delay)
    {
        const id = this.nextId++
        this.tasks.set(id, callback)
        this.delays.push(delay)
        return id
    }

    clearTimeout(id)
    {
        this.tasks.delete(id)
    }

    runNext()
    {
        const entry = this.tasks.entries().next().value
        if(!entry)
            return false
        const [ id, callback ] = entry
        this.tasks.delete(id)
        callback()
        return true
    }
}

function resetSockets()
{
    FakeSocket.instances.length = 0
}

function createServer(options = {})
{
    const timers = options.timers ?? new FakeTimers()
    const server = new Server({
        WebSocketClass: FakeSocket,
        baseHref: 'https://game.example/play',
        maxFrameBytes: options.maxFrameBytes ?? 1024,
        setTimeoutFn: timers.setTimeout.bind(timers),
        clearTimeoutFn: timers.clearTimeout.bind(timers),
    })
    return { server, timers }
}

test('v2 server normalizes room, keeps credentials out of URL, and sends resume first', () =>
{
    resetSockets()
    const { server } = createServer()
    const token = Uint8Array.from({ length: 32 }, (_, index) => index)
    let connected = 0
    server.events.on('connected', () => connected++)

    assert.equal(server.start({
        url: 'wss://multiplayer.example/ws?keep=1',
        room: '  Room A!  ',
        resume: {
            playerId: 9,
            lastServerTick: 42,
            resumeToken: token,
        },
    }), true)

    const socket = FakeSocket.instances[0]
    const url = new URL(socket.url)
    assert.equal(url.searchParams.get('keep'), '1')
    assert.equal(url.searchParams.get('room'), 'room-a')
    assert.equal(url.searchParams.get('protocol'), '2')
    assert.equal(url.href.includes('token'), false)
    assert.equal(url.href.includes(String(token)), false)
    assert.equal(socket.binaryType, 'arraybuffer')

    socket.open()

    assert.equal(connected, 1)
    assert.equal(socket.sent.length, 1)
    const resume = decodeResume(socket.sent[0])
    assert.equal(resume.playerId, 9)
    assert.equal(resume.lastServerTick, 42)
    assert.deepEqual(resume.resumeToken, token)
})

test('v2 server sends HELLO when no resume credential is available', () =>
{
    resetSockets()
    const { server } = createServer()
    assert.equal(server.start({
        url: 'wss://multiplayer.example/ws',
        room: 'PUBLIC',
    }), true)

    const socket = FakeSocket.instances[0]
    socket.open()

    assert.equal(socket.sent.length, 1)
    const hello = decodeHello(socket.sent[0])
    assert.equal(hello.clientTick, 0)
})

test('v2 server emits only validated binary frames and rejects text or malformed headers', () =>
{
    resetSockets()
    const { server } = createServer({ maxFrameBytes: 64 })
    const frames = []
    const errors = []
    server.events.on('frame', (frame) => frames.push(frame))
    server.events.on('error', (error) => errors.push(error))
    server.start({ url: 'wss://multiplayer.example/ws', room: 'test' })

    const socket = FakeSocket.instances[0]
    socket.open()
    socket.receive(encodeErrorFrame({
        code: 1,
        retryable: true,
        contextTick: 0,
        message: 'HELLO_REQUIRED',
    }).buffer)

    assert.equal(frames.length, 1)
    assert.ok(frames[0] instanceof Uint8Array)
    assert.equal(new DataView(frames[0].buffer, frames[0].byteOffset).getUint8(0), FRAME_TYPES.ERROR)

    socket.receive('not binary')
    assert.equal(errors.length, 1)
    assert.equal(socket.closeCalls.at(-1).code, 1003)

    const reconnect = FakeSocket.instances[1]
    reconnect.open()
    const malformed = new Uint8Array(8)
    const view = new DataView(malformed.buffer)
    view.setUint8(0, FRAME_TYPES.ERROR)
    view.setUint16(2, 2, true)
    view.setUint32(4, 10, true)
    reconnect.receive(malformed.buffer)
    assert.equal(errors.length, 2)
    assert.equal(reconnect.closeCalls.at(-1).code, 1002)
})

test('v2 server guards reconnects, caps exponential backoff, and clears timers on stop', () =>
{
    resetSockets()
    const { server, timers } = createServer()
    let disconnected = 0
    server.events.on('disconnected', () => disconnected++)
    server.start({ url: 'wss://multiplayer.example/ws', room: 'test' })

    let socket = FakeSocket.instances[0]
    socket.open()
    socket.close(1006, 'network')
    assert.equal(disconnected, 1)
    assert.deepEqual(timers.delays, [ 1000 ])
    assert.equal(timers.tasks.size, 1)

    socket.emit('close', { code: 1006 })
    assert.equal(timers.tasks.size, 1)

    for(let attempt = 0; attempt < 5; attempt++)
    {
        assert.equal(timers.runNext(), true)
        socket = FakeSocket.instances.at(-1)
        socket.close(1006, 'network')
    }

    assert.deepEqual(timers.delays, [ 1000, 2000, 4000, 8000, 15000, 15000 ])
    assert.equal(timers.tasks.size, 1)

    server.stop()
    assert.equal(timers.tasks.size, 0)
    assert.equal(server.connected, false)
    assert.equal(server.connecting, false)
    assert.equal(server.stopped, true)
})

test('input publisher reads and quantizes once, records the same object, and flushes every three ticks', () =>
{
    let playerReads = 0
    const player = {
        accelerating: 1,
        braking: 0.25,
        steering: -0.5,
        suspensions: [ 'low', 'mid', 'high', 'low' ],
        boosting: 1,
        honking: 0,
    }
    const game = {}
    Object.defineProperty(game, 'player', {
        get()
        {
            playerReads++
            return player
        },
    })

    const recorded = []
    const sent = []
    const publisher = new InputPublisher(game, {
        isActive: () => true,
        recordPredictionInput: (input) => recorded.push(input),
        sendFrame: (frame) =>
        {
            sent.push(frame)
            return true
        },
    })

    publisher.sample(10)
    publisher.sample(11)
    publisher.sample(12)

    assert.equal(playerReads, 3)
    assert.equal(recorded.length, 3)
    assert.equal(publisher.unacknowledgedInputs.length, 3)
    assert.strictEqual(recorded[0], publisher.unacknowledgedInputs[0])
    assert.strictEqual(recorded[1], publisher.unacknowledgedInputs[1])
    assert.strictEqual(recored[2], publisher.unacknowledgedInputs[2])
    assert.equal(sent.length, 1)
    assert.deepEqual(decodeInputBatch(sent[0]), recorded)
})

test('input publisher emits safe neutral input before active spawn', () =>
{
    let reads = 0
    const game = {}
    Object.defineProperty(game, 'player', {
        get()
        {
            reads$«
            return {
                accelerating: 1,
                braking: 0,
                steering: 1,
                suspensions: [ 'high', 'high', 'high', 'high' ],
                boosting: 1,
                honking: 1,
            }
        },
    })

    const recorded = []
    const publisher = new InputPublisher(game, {
        isActive: () => false,
        recordPredictionInput: (input) => recorded.push(input),
        sendFrame: () => true,
    })

    publisher.sample(3)

    assert.equal(reads, 1)
    assert.deepEqual(recorded[0], {
        clientTick: 3,
        sequence: 0,
        throttle: 128,
        brake: 255,
        steering: 0,
        suspensions: 0,
        flags: 0,
    })
})

test('input publisher batches at most six and retains exactly sixty latest unacknowledged inputs', () =>
{
    const attempts = []
    let sendAttempts = 0
    const publisher = new InputPublisher({
        player: {
            accelerating: 0,
            braking: 0,
            steering: 0,
            suspensions: [ 'low', 'low', 'low', 'low' ],
            boosting: 0,
            honking: 0,
        },
    }, {
        isActive: () => true,
        recordPredictionInput: () => {},
        sendFrame: (frame) =>
        {
            const batch = decodeInputBatch(frame)
            attempts.push(batch)
            sendAttempts++
            return sendAttempts > 1
        },
    })

    for(let tick = 0; tick < 65; tick+)
        publisher.sample(tick)

    assert.equal(attempts[0].length, 3)
    assert.equal(attempts[1].length, 6)
    assert.ok(attempts.every((batch) => batch.length <= 6))
    assert.equal(publisher.unacknowledgedInputs.length, 60)
    assert.equal(publisher.unacknowledgedInputs[0].sequence, 5)
    assert.equal(publisher.unacknowledgedInputs.at(-1).sequence, 64)
})
