import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    LIFECYCLE_FRAME_TYPES,
    ROOM_EVENT_TYPES,
    decodeFullSyncRequest,
    decodeSyncReady,
    encodeFullSyncFrame,
    encodeResume,
    encodeStateFrame,
    encodeFullSyncRequest,
    encodeSyncReady,
} from '@ch-folio/authoritative-physics'
import { Events } from '../sources/Game/Events.js'
import {
    AuthoritativeMultiplayer,
    credentialStorageKey,
} from '../sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js'
import { SyncOverlay } from '../sources/Game/MultiplayerV2/SyncOverlay.js'

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

class FakeStorage
{
    constructor()
    {
        this.values = new Map()
    }

    getItem(key)
    {
        return this.values.get(String(key)) ?? null
    }

    setItem(key, value)
    {
        this.values.set(String(key), String(value))
    }

    removeItem(key)
    {
        this.values.delete(String(key))
    }
}

class FakeServer
{
    constructor()
    {
        this.events = new Events()
        this.connected = false
        this.startCalls = []
        this.sent = []
        this.stopCalls = 0
    }

    start(options)
    {
        this.startCalls.push(options)
        this.connected = true
        this.events.trigger('connected')
        return true
    }

    sendFrame(frame)
    {
        this.sent.push(frame)
        return this.connected
    }

    stop()
    {
        this.stopCalls++
        this.connected = false
    }

    emitFrame(frame)
    {
        this.events.trigger('frame', [ frame ])
    }

    disconnect()
    {
        this.connected = false
        this.events.trigger('disconnected')
    }
}

class FakePredictionWorld
{
    constructor()
    {
        this.tick = 0
        this.states = []
        this.destroyed = false
    }

    restoreFullSync(sync)
    {
        this.tick = sync.checkpointTick >>> 0
        this.states = sync.entities
            .filter((entity) => (entity.flags & 1) !== 0)
            .map((entity) => ({ entityOrder: entity.entityOrder }))
    }

    readState(entityOrder = null)
    {
        if(entityOrder === null)
            return this.states.map((state) => ({ ...state }))
        const state = this.states.find((candidate) => candidate.entityOrder === entityOrder)
        if(!state)
            throw new Error(`unknown entityOrder ${entityOrder}`)
        return { ...state }
    }

    destroy()
    {
        this.destroyed = true
    }
}

class FakeVehicleVisuals
{
    constructor(options)
    {
        this.options = options
        this.updateCalls = []
        this.reconcileCalls = []
        this.destroyed = false
    }

    reconcile(before, after, options)
    {
        this.reconcileCalls.push({ before, after, options })
    }

    update(delta)
    {
        this.updateCalls.push(delta)
        return this.options.predictionWorld.readState().length
    }

    destroy()
    {
        this.destroyed = true
    }
}

class FakeReconciler
{
    constructor(options)
    {
        this.options = options
        this.predictionWorld = options.predictionWorld
        this.predictCalls = []
        this.fullSyncCalls = []
        this.stateCalls = []
        this.destroyed = false
    }

    applyFullSync(sync)
    {
        this.fullSyncCalls.push(sync)
        this.predictionWorld.restoreFullSync(sync)
        this.predictionWorld.tick = sync.serverTick >>> 0
        return {
            status: 'hard-synced',
            serverTick: sync.serverTick,
            currentTick: sync.serverTick,
            replayedTicks: Math.max(0, sync.serverTick - sync.checkpointTick),
        }
    }

    async reconcileState(frame)
    {
        this.stateCalls.push(frame)
        this.predictionWorld.tick = frame.serverTick >>> 0
        this.predictionWorld.states = frame.states.map((state) => ({
            entityOrder: state.entityOrder,
        }))
        return {
            status: 'confirmed',
            serverTick: frame.serverTick,
            currentTick: frame.serverTick,
            rolledBack: false,
        }
    }

    predict({ inputs = [], events = [] } = {})
    {
        this.predictCalls.push({ inputs, events })
        this.predictionWorld.tick++
        return this.predictionWorld.tick
    }

    destroy()
    {
        this.destroyed = true
    }
}

class FakeInputPublisher
{
    constructor(game, options)
    {
        this.game = game
        this.options = options
        this.samples = []
        this.acknowledgements = []
        this.sequence = 0
    }

    sample(tick)
    {
        const active = this.options.isActive()
        const input = {
            clientTick: tick >>> 0,
            sequence: this.sequence++,
            throttle: active ? 255 : 128,
            brake: active ? 0 : 255,
            steering: 0,
            suspensions: 0,
            flags: 0,
        }
        this.samples.push({ tick, active, input })
        this.options.recordPredictionInput(input)
        return input
    }

    acknowledge(sequence)
    {
        this.acknowledgements.push(sequence)
        return 0
    }
}

class FakeOverlay
{
    constructor()
    {
        this.states = []
        this.destroyed = false
    }

    setState(state, detail)
    {
        this.states.push({ state, detail })
    }

    destroy()
    {
        this.destroyed = true
    }
}

function createGame()
{
    return {
        RAPIER: {},
        physicalVehicle: {
            setExternalSimulation() {},
            applyExternalState() {},
        },
        remoteVehicleTemplate: {},
        player: {},
        ticker: {
            delta: 1 / 60,
            events: new Events(),
        },
    }
}

function createCoordinator({ storage = new FakeStorage(), room = 'Room A' } = {})
{
    const game = createGame()
    const server = new FakeServer()
    const coordinator = new AuthoritativeMultiplayer(game, {
        server,
        storage,
        serverUrl: 'wss://multiplayer.example/ws',
        PredictionWorldClass: FakePredictionWorld,
        VehicleVisualsClass: FakeVehicleVisuals,
        ReconcilerClass: FakeReconciler,
        InputPublisherClass: FakeInputPublisher,
        SyncOverlayClass: FakeOverlay,
    })
    assert.equal(coordinator.start({ room }), true)
    return { coordinator, game, server, storage }
}

function grantFrame(playerId, tokenByte, lastServerTick = 5)
{
    return encodeResume({
        playerId,
        lastServerTick,
        resumeToken: new Uint8Array(32).fill(tokenByte),
    })
}

function fullSyncFrame({ playerId, hasBody = false, checkpointTick = 5, serverTick = 8 } = {})
{
    return encodeFullSyncFrame({
        checkpointTick,
        serverTick,
        eventCursor: 0,
        checksum32: 0,
        snapshot: Uint8Array.of(1, 2, 3),
        entities: [ {
            entityOrder: 1,
            slotState: hasBody ? 3 : 1,
            spawnIndex: hasBody ? 0 : 0xff,
            flags: hasBody ? 1 : 0,
            playerId,
            lastConfirmedSequence: 0,
            controllerOffset: 0,
            controllerLength: 0,
        } ],
        controllerMetadata: new Uint8Array(),
        queuedInputs: [],
    })
}

function activeStateFrame(serverTick = 9)
{
    return encodeStateFrame({
        serverTick,
        eventCursor: 1,
        checksum32: 0,
        states: [ {
            entityOrder: 1,
            stateFlags: 3,
            collisionFlags: 0,
            suspensions: 0,
            lastConfirmedSequence: 0,
            position: [ 0, 1, 0 ],
            quaternion: [ 0, 0, 0, 1 ],
            linearVelocity: [ 0, 0, 0 ],
            angularVelocity: [ 0, 0, 0 ],
            steering: 0,
            wheelRotations: [ 0, 0, 0, 0 ],
            controlFlags: 0,
            throttle: 128,
            brake: 255,
            inputFlags: 0,
        } ],
        events: [ {
            cursor: 1,
            type: ROOM_EVENT_TYPES.SPAWN,
            entityOrder: 1,
            spawnIndex: 0,
            flags: 1,
            tick: serverTick,
            value: 77,
        } ],
        worldHash: null,
    })
}

async function settle(coordinator)
{
    await coordinator.whenIdle()
    await Promise.resolve()
}

test('lifecycle control frames are fixed binary protocol-v2 messages', () =>
{
    const syncReady = encodeSyncReady()
    const fullSyncRequest = encodeFullSyncRequest()

    assert.equal(syncReady.byteLength, 8)
    assert.equal(fullSyncRequest.byteLength, 8)
    assert.equal(syncReady[0], LIFECYCLE_FRAME_TYPES.SYNC_READY)
    assert.equal(fullSyncRequest[0], LIFECYCLE_FRAME_TYPES.FULL_SYNC_REQUEST)
    assert.deepEqual(decodeSyncReady(syncReady), { protocolVersion: 2 })
    assert.deepEqual(decodeFullSyncRequest(fullSyncRequest), { protocolVersion: 2 })

    const malformed = Uint8Array.from(syncReady)
    new DataView(malformed.buffer).setUint32(4, 1, true)
    assert.throws(() => decodeSyncReady(malformed), /payload length/i)
})

test('full sync fast-forwards without rendering, waits for exact spawn, then enables effective input', async () =>
{
    const { coordinator, game, server } = createCoordinator()
    server.emitFrame(grantFrame(77, 1))
    server.emitFrame(fullSyncFrame({ playerId: 77 }))
    await settle(coordinator)

    assert.equal(coordinator.state, 'waiting_spawn')
    assert.equal(coordinator.predictionWorld.tick, 8)
    assert.equal(coordinator.visuals.updateCalls.length, 0)
    assert.equal(server.sent.length, 1)
    assert.deepEqual(decodeSyncReady(server.sent[0]), { protocolVersion: 2 })

    game.ticker.events.trigger('tick')
    assert.equal(coordinator.inputPublisher.samples.at(-1).active, false)
    assert.equal(coordinator.reconciler.predictCalls.length, 1)

    server.emitFrame(activeStateFrame(9))
    await settle(coordinator)
    assert.equal(coordinator.state, 'active')

    game.ticker.events.trigger('tick')
    assert.equal(coordinator.inputPublisher.samples.at(-1).active, true)
    assert.equal(coordinator.visuals.updateCalls.length, 1)
    assert.deepEqual(
        coordinator.overlay.states.map(({ state }) => state),
        [ 'stopped', 'connecting', 'syncing', 'waiting_spawn', 'active' ],
    )
})

test('credentials are room-scoped, rotate in sessionStorage, survive reconnect, and clear on explicit stop', async () =>
{
    const storage = new FakeStorage()
    const { coordinator, server } = createCoordinator({ storage, room: ' Room A ' })
    const roomAKey = credentialStorageKey('room-a')
    const roomBKey = credentialStorageKey('room-b')
    storage.setItem(roomBKey, JSON.stringify({ sentinel: true }))

    server.emitFrame(grantFrame(91, 3, 11))
    await settle(coordinator)
    const first = JSON.parse(storage.getItem(roomAKey))
    assert.equal(first.playerId, 91)
    assert.equal(first.lastServerTick, 11)
    assert.match(first.resumeToken, /^[A-Za-z0-9_-]{43}$/)

    server.emitFrame(grantFrame(91, 4, 12))
    await settle(coordinator)
    const rotated = JSON.parse(storage.getItem(roomAKey))
    assert.notEqual(rotated.resumeToken, first.resumeToken)

    server.disconnect()
    assert.equal(coordinator.state, 'reconnecting')
    assert.notEqual(storage.getItem(roomAKey), null)

    assert.equal(coordinator.stop(), true)
    assert.equal(storage.getItem(roomAKey), null)
    assert.equal(storage.getItem(roomBKey), JSON.stringify({ sentinel: true }))
    assert.equal(server.stopCalls, 1)
})

test('stored resume data is loaded only for the normalized room and storage failures degrade safely', () =>
{
    const storage = new FakeStorage()
    const roomAKey = credentialStorageKey('room-a')
    storage.setItem(roomAKey, JSON.stringify({
        playerId: 44,
        lastServerTick: 20,
        resumeToken: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    }))

    const roomA = createCoordinator({ storage, room: 'ROOM A' })
    assert.equal(roomA.server.startCalls[0].resume.playerId, 44)
    roomA.coordinator.stop()

    const roomB = createCoordinator({ storage, room: 'room-b' })
    assert.equal(roomB.server.startCalls[0].resume, null)
    roomB.coordinator.stop()

    const deniedStorage = {
        getItem() { throw new DOMException('denied', 'SecurityError') },
        setItem() { throw new DOMException('denied', 'SecurityError') },
        removeItem() { throw new DOMException('denied', 'SecurityError') },
    }
    const denied = createCoordinator({ storage: deniedStorage, room: 'denied' })
    assert.equal(denied.server.startCalls[0].resume, null)
    assert.doesNotThrow(() => denied.coordinator.stop())
})

test('incompatible transport clears credentials and stops reconnecting', async () =>
{
    const { coordinator, server, storage } = createCoordinator()
    const key = credentialStorageKey('room-a')
    server.emitFrame(grantFrame(55, 8))
    await settle(coordinator)
    assert.notEqual(storage.getItem(key), null)

    server.events.trigger('error', [ new Error(
        'incompatible protocolVersion: expected 2, received 3',
    ) ])
    await settle(coordinator)

    assert.equal(coordinator.state, 'incompatible')
    assert.equal(storage.getItem(key), null)
    assert.equal(server.connected, false)
})

test('sync overlay presents waiting and incompatible states and hides active/stopped states', () =>
{
    const appended = []
    const document = {
        body: { appendChild: (element) => appended.push(element) },
        createElement()
        {
            return {
                style: {},
                hidden: false,
                textContent: '',
                attributes: {},
                setAttribute(name, value) { this.attributes[name] = value },
                remove() { this.removed = true },
            }
        },
    }

    const overlay = new SyncOverlay({ document })
    overlay.setState('waiting_spawn')
    assert.equal(appended.length, 1)
    assert.equal(appended[0].hidden, false)
    assert.match(appended[0].textContent, /安全出生点/)

    overlay.setState('active')
    assert.equal(appended[0].hidden, true)
    overlay.setState('incompatible')
    assert.equal(appended[0].hidden, false)
    assert.match(appended[0].textContent, /不兼容/)
    overlay.setState('stopped')
    assert.equal(appended[0].hidden, true)

    overlay.destroy()
    assert.equal(appended[0].removed, true)
})

test('application selects v1 or v2 only behind the explicit protocol and room gates', async () =>
{
    const source = await readSource('../sources/index.js')

    assert.match(source, /AuthoritativeMultiplayer\.js/)
    assert.match(source, /VITE_MULTIPLAYER_PROTOCOL/)
    assert.match(source, /multiplayerProtocol\s*===\s*['"]1['"]/)
    assert.match(source, /new Multiplayer\(game\)/)
    assert.match(source, /multiplayerProtocol\s*===\s*['"]2['"]/)
    assert.match(source, /new AuthoritativeMultiplayer\(game\)/)
    assert.match(source, /multiplayerEnabled\s*&&\s*import\.meta\.env\.VITE_SERVER_URL\s*&&\s*multiplayerRoom/)
    assert.match(source, /if\(multiplayer\)\s*\n\s*multiplayer\.start\(\{\s*room:\s*multiplayerRoom\s*\}\)/)
    assert.doesNotMatch(source, /VITE_MULTIPLAYER_PROTOCOL\s*\|\|\s*['"]2['"]/)
})
