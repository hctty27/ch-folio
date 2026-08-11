import assert from 'node:assert/strict'
import test from 'node:test'

import { Reconciler, localError } from '../sources/Game/MultiplayerV2/Reconciler.js'

function clone(value)
{
    return structuredClone(value)
}

function state({
    entityOrder = 1,
    position = [ 0, 0, 0 ],
    quaternion = [ 0, 0, 0, 1 ],
    linearVelocity = [ 0, 0, 0 ],
    angularVelocity = [ 0, 0, 0 ],
    lastConfirmedSequence = 9,
} = {})
{
    return {
        entityOrder,
        stateFlags: 2,
        collisionFlags: 0,
        suspensions: 0,
        lastConfirmedSequence,
        position: [ ...position ],
        quaternion: [ ...quaternion ],
        linearVelocity: [ ...linearVelocity ],
        angularVelocity: [ ...angularVelocity ],
        steering: 0,
        wheelRotations: [ 0, 0, 0, 0 ],
        controlFlags: 0,
        throttle: 255,
        brake: 0,
        inputFlags: 0,
    }
}

function frame({
    serverTick = 100,
    local = state(),
    remote = null,
    checksum32 = 0xfeedbeef,
} = {})
{
    return {
        serverTick,
        eventCursor: 0,
        checksum32,
        states: remote ? [ local, remote ] : [ local ],
        events: [],
        worldHash: null,
    }
}

function predictionRecord(predictionTick, commandTick, sequence)
{
    return {
        predictionTick,
        entityOrder: 1,
        input: {
            clientTick: commandTick,
            sequence,
            throttle: 255,
            brake: 0,
            steering: 0,
            suspensions: 0,
            flags: 0,
        },
    }
}

class FakePredictionWorld
{
    constructor()
    {
        this.tick = 99
        this.local = state({ lastConfirmedSequence: 8 })
        this.inputApplicationTicks = []
        this.applyLocalCalls = []
    }

    step({ inputs = [] } = {})
    {
        this.tick = (this.tick + 1) >>> 0
        if(inputs.length > 0)
            this.inputApplicationTicks.push(this.tick)
        const input = inputs.find((record) => record.entityOrder === 1)?.input
        if(input)
            this.local.lastConfirmedSequence = input.sequence >>> 0
        return this.tick
    }

    readState(entityOrder = null)
    {
        if(entityOrder === null)
            return [ clone(this.local) ]
        return entityOrder === 1 ? clone(this.local) : null
    }

    checksum()
    {
        return 0x12345678
    }

    createCheckpoint()
    {
        return {
            tick: this.tick,
            snapshot: new Uint8Array([ this.tick & 0xff ]),
        }
    }

    restoreCheckpoint(checkpoint)
    {
        this.tick = checkpoint.tick >>> 0
    }

    applyStateFrame(authoritativeFrame)
    {
        const local = authoritativeFrame.states.find((candidate) => candidate.entityOrder === 1)
        if(local)
            this.local = clone(local)
        this.tick = authoritativeFrame.serverTick >>> 0
        return this.checksum()
    }

    applyLocalAuthoritativeState(authoritativeLocal, serverTick)
    {
        this.applyLocalCalls.push(serverTick >>> 0)
        this.local = clone(authoritativeLocal)
        this.tick = serverTick >>> 0
        return this.readState(1)
    }

    captureFullSync()
    {
        return {
            serverTick: this.tick,
            eventCursor: 0,
            snapshot: new Uint8Array([ this.tick & 0xff ]),
            entities: [ {
                entityOrder: 1,
                lastConfirmedSequence: this.local.lastConfirmedSequence,
            } ],
            queuedInputs: [],
            local: clone(this.local),
        }
    }

    restoreFullSync(sync)
    {
        this.tick = sync.serverTick >>> 0
        if(sync.local)
            this.local = clone(sync.local)
        return this.readState()
    }
}

function createReconciler(world = new FakePredictionWorld(), options = {})
{
    const acknowledgements = []
    const fullSyncRequests = []
    const visualCorrections = []
    const reconciler = new Reconciler({
        predictionWorld: world,
        localEntityOrder: 1,
        checkpointIntervalTicks: 1,
        acknowledgeInput: (sequence) => acknowledgements.push(sequence),
        requestFullSync: (reason) => fullSyncRequests.push(reason),
        reconcileVisuals: (...args) => visualCorrections.push(args),
        ...options,
    })
    return {
        reconciler,
        world,
        acknowledgements,
        fullSyncRequests,
        visualCorrections,
    }
}

function seedPredictedTick100(context)
{
    context.reconciler.captureTick()
    context.reconciler.predict({
        predictionTick: 100,
        inputs: [ predictionRecord(100, 97, 9) ],
    })
}

test('remote-only authoritative changes do not rollback the local owner', async () =>
{
    const context = createReconciler()
    seedPredictedTick100(context)
    const predictedLocal = context.world.readState(1)
    const result = await context.reconciler.reconcileState(frame({
        local: predictedLocal,
        remote: state({ entityOrder: 2, position: [ 50, 0, 0 ] }),
        checksum32: 0x87654321,
    }))

    assert.equal(result.status, 'confirmed')
    assert.equal(result.rolledBack, false)
    assert.deepEqual(context.world.applyLocalCalls, [])
    assert.deepEqual(context.fullSyncRequests, [])
    context.reconciler.destroy()
})

test('local state inside soft tolerances confirms without rollback', async () =>
{
    const context = createReconciler()
    seedPredictedTick100(context)
    const predicted = context.world.readState(1)
    const result = await context.reconciler.reconcileState(frame({
        local: state({
            position: [ predicted.position[0] + 0.02, 0, 0 ],
            quaternion: [ 0, Math.sin(0.2 * Math.PI / 180), 0, Math.cos(0.2 * Math.PI / 180) ],
            linearVelocity: [ 0.1, 0, 0 ],
            angularVelocity: [ 0.03, 0, 0 ],
            lastConfirmedSequence: 9,
        }),
    }))

    assert.equal(result.status, 'confirmed')
    assert.equal(result.rolledBack, false)
    assert.ok(result.error.position < 0.05)
    assert.ok(result.error.rotation < Math.PI / 180)
    assert.deepEqual(context.world.applyLocalCalls, [])
    context.reconciler.destroy()
})

test('material local error restores authority and replays by predictionTick', async () =>
{
    const context = createReconciler()
    seedPredictedTick100(context)
    context.reconciler.predict({
        predictionTick: 101,
        inputs: [ predictionRecord(101, 98, 10) ],
    })
    context.reconciler.predict({
        predictionTick: 102,
        inputs: [ predictionRecord(102, 99, 11) ],
    })
    context.world.inputApplicationTicks.length = 0

    const result = await context.reconciler.reconcileState(frame({
        local: state({ position: [ 0.2, 0, 0 ], lastConfirmedSequence: 9 }),
    }))

    assert.equal(result.status, 'rolled-back')
    assert.equal(result.rolledBack, true)
    assert.equal(result.replayedTicks, 2)
    assert.deepEqual(context.world.applyLocalCalls, [ 100 ])
    assert.deepEqual(context.world.inputApplicationTicks, [ 101, 102 ])
    assert.deepEqual(context.fullSyncRequests, [])
    context.reconciler.destroy()
})

test('localError reports physical vector magnitudes and shortest quaternion angle', () =>
{
    const halfAngle = 5 * Math.PI / 180
    const error = localError(
        state(),
        state({
            position: [ 3, 4, 0 ],
            quaternion: [ 0, Math.sin(halfAngle), 0, Math.cos(halfAngle) ],
            linearVelocity: [ 0, 0, 2 ],
            angularVelocity: [ 0, 0.3, 0.4 ],
        }),
    )

    assert.equal(error.position, 5)
    assert.ok(Math.abs(error.rotation - 10 * Math.PI / 180) < 1e-12)
    assert.equal(error.linearVelocity, 2)
    assert.equal(error.angularVelocity, 0.5)
})
