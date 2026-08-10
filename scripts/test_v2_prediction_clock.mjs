import assert from 'node:assert/strict'
import test from 'node:test'

import { AuthoritativeMultiplayer, AUTHORITATIVE_MULTIPLAYER_STATES } from '../sources/Game/MultiplayerV2/AuthoritativeMultiplayer.js'

class FakeEvents
{
    on() {}
    off() {}
}

class FakeOverlay
{
    setState() {}
    destroy() {}
}

function createCoordinator()
{
    const game = {
        ticker: {
            delta: 1 / 60,
            events: new FakeEvents(),
        },
    }
    const coordinator = new AuthoritativeMultiplayer(game, {
        server: {
            events: new FakeEvents(),
            sendFrame: () => true,
            stop() {},
        },
        serverUrl: 'wss://example.test/ws',
        SyncOverlayClass: FakeOverlay,
    })
    coordinator.started = true
    coordinator.state = AUTHORITATIVE_MULTIPLAYER_STATES.ACTIVE
    coordinator.localEntityOrder = 1
    return coordinator
}

function inputAt(tick)
{
    return {
        clientTick: (tick - 3) >>> 0,
        sequence: tick >>> 0,
        throttle: 255,
        brake: 0,
        steering: 0,
        suspensions: 0,
        flags: 0,
    }
}

test('active client predicts to synchronizer target instead of free-running browser time', () =>
{
    const coordinator = createCoordinator()
    const predictionTicks = []
    const sampledTicks = []
    const visualUpdates = []
    coordinator.predictionWorld = {
        tick: 105,
        readState: () => ({ entityOrder: 1 }),
    }
    coordinator.inputPublisher = {
        sample(tick)
        {
            sampledTicks.push(tick)
            return inputAt(tick)
        },
    }
    coordinator.reconciler = {
        predict({ predictionTick })
        {
            predictionTicks.push(predictionTick)
            coordinator.predictionWorld.tick = predictionTick >>> 0
        },
    }
    coordinator.visuals = {
        update(delta, interpolationTick)
        {
            visualUpdates.push({ delta, interpolationTick })
        },
    }
    coordinator.tickSynchronizer = {
        desiredPredictionTick: () => 108,
        interpolationTick: () => 96,
    }

    coordinator.update()

    assert.equal(coordinator.predictionWorld.tick, 108)
    assert.deepEqual(predictionTicks, [ 106, 107, 108 ])
    assert.deepEqual(sampledTicks, [ 106, 107, 108 ])
    assert.equal(visualUpdates.length, 1)
    assert.equal(visualUpdates[0].interpolationTick, 96)
})

test('client pauses simulation when already ahead but keeps rendering remote interpolation', () =>
{
    const coordinator = createCoordinator()
    let predictionCalls = 0
    let visualCalls = 0
    coordinator.predictionWorld = {
        tick: 102,
        readState: () => ({ entityOrder: 1 }),
    }
    coordinator.inputPublisher = {
        sample: () => inputAt(103),
    }
    coordinator.reconciler = {
        predict()
        {
            predictionCalls++
            coordinator.predictionWorld.tick++
        },
    }
    coordinator.visuals = {
        update(delta, interpolationTick)
        {
            void delta
            visualCalls++
            assert.equal(interpolationTick, 94)
        },
    }
    coordinator.tickSynchronizer = {
        desiredPredictionTick: () => 100,
        interpolationTick: () => 94,
    }

    coordinator.update()

    assert.equal(coordinator.predictionWorld.tick, 102)
    assert.equal(predictionCalls, 0)
    assert.equal(visualCalls, 1)
})

test('STATE observes clock and stores remote snapshots before local reconciliation', async () =>
{
    const coordinator = createCoordinator()
    const callOrder = []
    coordinator.lastServerTick = 119
    coordinator.predictionWorld = {
        readState: () => [ { entityOrder: 1 } ],
    }
    coordinator.tickSynchronizer = {
        observeState(serverTick)
        {
            callOrder.push(`observe-state-${serverTick}`)
            return true
        },
    }
    coordinator.visuals = {
        acceptAuthoritativeStateFrame(frame)
        {
            callOrder.push(`accept-remote-snapshots-${frame.serverTick}`)
        },
    }
    coordinator.reconciler = {
        async reconcileState(frame)
        {
            callOrder.push(`reconcile-local-${frame.serverTick}`)
            return { status: 'confirmed' }
        },
    }
    coordinator.writeCredential = () => {}
    coordinator.refreshSpawnState = () => true

    await coordinator.acceptStateFrame({
        serverTick: 120,
        eventCursor: 0,
        checksum32: 0,
        states: [ { entityOrder: 1, lastConfirmedSequence: 7 } ],
        events: [],
        worldHash: null,
    })

    assert.deepEqual(callOrder, [
        'observe-state-120',
        'accept-remote-snapshots-120',
        'reconcile-local-120',
    ])
})
