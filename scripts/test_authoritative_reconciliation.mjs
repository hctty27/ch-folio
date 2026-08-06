import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    hashWorldSnapshot,
    quantizeInput,
} from '@ch-folio/authoritative-physics'
import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { InputPublisher } from '../sources/Game/MultiplayerV2/InputPublisher.js'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'
import { Reconciler } from '../sources/Game/MultiplayerV2/Reconciler.js'
import { VisualCorrection } from '../sources/Game/MultiplayerV2/VisualCorrection.js'

const RAPIER = await loadRapierForNode()
const mapData = JSON.parse(await readFile(
    new URL('../packages/authoritative-physics/generated/map-v1.json', import.meta.url),
    'utf8',
))

const makeInput = (clientTick, sequence, steering = 0, throttle = 0.65) => quantizeInput({
    clientTick,
    sequence,
    throttle,
    brake: 0,
    steering,
    suspensions: [ 'low', 'low', 'low', 'low' ],
    boosting: false,
    honking: false,
})

const stateFrame = (prediction, extra = {}) => ({
    serverTick: prediction.tick,
    eventCursor: prediction.eventCursor,
    checksum32: prediction.checksum(),
    states: prediction.canonicalStates(),
    events: [],
    worldHash: null,
    ...extra,
})

const physicalState = (state) => ({
    entityOrder: state.entityOrder,
    position: state.position.map(Math.fround),
    quaternion: state.quaternion.map(Math.fround),
    linearVelocity: state.linearVelocity.map(Math.fround),
    angularVelocity: state.angularVelocity.map(Math.fround),
    lastConfirmedSequence: state.lastConfirmedSequence,
})

function createPrediction()
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.add(1, mapData.spawns[0])
    return prediction
}

test('matching authoritative state confirms input without rollback', async () =>
{
    const prediction = createPrediction()
    const acknowledgements = []
    const corrections = []
    const reconciler = new Reconciler({
        predictionWorld: prediction,
        localEntityOrder: 1,
        checkpointIntervalTicks: 1,
        acknowledgeInput: (sequence) => acknowledgements.push(sequence),
        reconcileVisuals: (...args) => corrections.push(args),
    })

    for(let tick = 1; tick <= 3; tick++)
        reconciler.predict({ inputs: [ { entityOrder: 1, input: makeInput(tick, tick, 0.1) } ] })

    const before = prediction.world.takeSnapshot()
    const result = await reconciler.reconcileState(stateFrame(prediction))

    assert.deepEqual(result, {
        status: 'confirmed',
        serverTick: 3,
        currentTick: 3,
        rolledBack: false,
    })
    assert.deepEqual(acknowledgements, [ 4 ])
    assert.equal(corrections.length, 0)
    assert.deepEqual(prediction.world.takeSnapshot(), before)
    reconciler.destroy()
    prediction.destroy()
})

test('checksum mismatch inside the retained window restores the authoritative tick and replays inputs', async () =>
{
    const server = createPrediction()
    const client = createPrediction()
    const corrections = []
    const reconciler = new Reconciler({
        predictionWorld: client,
        localEntityOrder: 1,
        checkpointIntervalTicks: 1,
        reconcileVisuals: (before, after, options) => corrections.push({ before, after, options }),
    })

    let authoritativeFrame = null
    for(let tick = 1; tick <= 6; tick++)
    {
        const serverInput = makeInput(tick, tick, 0.1)
        const clientInput = makeInput(tick, tick, tick === 3 ? 0.9 : 0.1)
        server.step({ inputs: [ { entityOrder: 1, input: serverInput } ] })
        reconciler.predict({ inputs: [ { entityOrder: 1, input: clientInput } ] })
        if(tick === 3)
            authoritativeFrame = stateFrame(server)
    }

    const expected = server.readState().map(physicalState)
    assert.notDeepEqual(client.readState().map(physicalState), expected)

    const result = await reconciler.reconcileState(authoritativeFrame)
    assert.equal(result.status, 'rolled-back')
    assert.equal(result.serverTick, 3)
    assert.equal(result.currentTick, 6)
    assert.equal(result.replayedTicks, 3)
    assert.deepEqual(client.readState().map(physicalState), expected)
    assert.equal(corrections.length, 1)
    assert.equal(corrections[0].options.hard, false)

    reconciler.destroy()
    server.destroy()
    client.destroy()
})

test('state older than the rollback window requests a hard sync without mutating prediction', async () =>
{
    const server = createPrediction()
    const client = createPrediction()
    const requests = []
    const reconciler = new Reconciler({
        predictionWorld: client,
        localEntityOrder: 1,
        maxRollbackTicks: 2,
        checkpointIntervalTicks: 1,
        requestFullSync: (reason) => requests.push(reason),
    })

    server.step({ inputs: [ { entityOrder: 1, input: makeInput(1, 1, -0.2) } ] })
    const oldFrame = stateFrame(server)
    for(let tick = 1; tick <= 5; tick++)
        reconciler.predict({ inputs: [ { entityOrder: 1, input: makeInput(tick, tick, 0.7) } ] })

    const before = client.world.takeSnapshot()
    const result = await reconciler.reconcileState(oldFrame)

    assert.deepEqual(result, {
        status: 'hard-sync-requested',
        reason: 'rollback-window-exceeded',
        serverTick: 1,
        currentTick: 5,
    })
    assert.deepEqual(requests, [ 'rollback-window-exceeded' ])
    assert.deepEqual(client.world.takeSnapshot(), before)

    reconciler.destroy()
    server.destroy()
    client.destroy()
})

test('world hash mismatch requests full sync before accepting an otherwise matching frame', async () =>
{
    const prediction = createPrediction()
    const requests = []
    const reconciler = new Reconciler({
        predictionWorld: prediction,
        localEntityOrder: 1,
        checkpointIntervalTicks: 1,
        requestFullSync: (reason) => requests.push(reason),
    })

    reconciler.predict({ inputs: [ { entityOrder: 1, input: makeInput(1, 1, 0.1) } ] })
    const snapshotHash = await hashWorldSnapshot(prediction.createCheckpoint().snapshot)
    const wrongHash = Uint8Array.from(snapshotHash)
    wrongHash[0] ^= 0xff

    const result = await reconciler.reconcileState(stateFrame(prediction, {
        worldHash: { hashTick: 1, sha256: wrongHash },
    }))

    assert.equal(result.status, 'hard-sync-requested')
    assert.equal(result.reason, 'world-hash-mismatch')
    assert.deepEqual(requests, [ 'world-hash-mismatch' ])

    reconciler.destroy()
    prediction.destroy()
})

test('full sync restores the snapshot, replays retained local inputs, and hard-reconciles visuals', () =>
{
    const source = createPrediction()
    const client = createPrediction()
    const corrections = []
    const reconciler = new Reconciler({
        predictionWorld: client,
        localEntityOrder: 1,
        checkpointIntervalTicks: 1,
        reconcileVisuals: (before, after, options) => corrections.push({ before, after, options }),
    })

    let sync = null
    for(let tick = 1; tick <= 6; tick++)
    {
        const input = makeInput(tick, tick, tick < 3 ? -0.15 : 0.2)
        source.step({ inputs: [ { entityOrder: 1, input } ] })
        reconciler.predict({ inputs: [ {
            entityOrder: 1,
            input: makeInput(tick, tick, tick === 2 ? 0.95 : 0.2),
        } ] })
        if(tick === 3)
            sync = source.captureFullSync()
    }

    const expected = source.readState().map(physicalState)
    const result = reconciler.applyFullSync(sync)

    assert.equal(result.status, 'hard-synced')
    assert.equal(result.serverTick, 3)
    assert.equal(result.currentTick, 6)
    assert.equal(result.replayedTicks, 3)
    assert.deepEqual(client.readState().map(physicalState), expected)
    assert.equal(corrections.length, 1)
    assert.equal(corrections[0].options.hard, true)

    reconciler.destroy()
    source.destroy()
    client.destroy()
})

test('visual correction decays position and quaternion over 100ms and snaps large errors', () =>
{
    const correction = new VisualCorrection({ durationSeconds: 0.1, snapDistance: 3 })
    const before = [ {
        entityOrder: 1,
        position: [ 0, 0, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
    } ]
    const after = [ {
        entityOrder: 1,
        position: [ 1, 0, 0 ],
        quaternion: [ 0, Math.SQRT1_2, 0, Math.SQRT1_2 ],
    } ]

    correction.capture(before, after)
    assert.deepEqual(correction.apply(after[0]).position, [ 0, 0, 0 ])
    assert.deepEqual(correction.apply(after[0]).quaternion.map(Math.fround), before[0].quaternion)

    correction.advance(0.05)
    const halfway = correction.apply(after[0])
    assert.equal(halfway.position[0], 0.5)
    assert.ok(Math.abs(halfway.quaternion[1] - 0.3826834323650898) < 1e-12)
    assert.ok(Math.abs(halfway.quaternion[3] - 0.9238795325112867) < 1e-12)

    correction.advance(0.05)
    assert.deepEqual(correction.apply(after[0]), after[0])

    correction.capture(before, [ { ...after[0], position: [ 4, 0, 0 ] } ])
    assert.deepEqual(
        correction.apply({ ...after[0], position: [ 4, 0, 0 ] }).position,
        [ 4, 0, 0 ],
    )
})

test('input publisher acknowledges confirmed sequences without dropping newer inputs', () =>
{
    const publisher = new InputPublisher({
        player: {
            accelerating: 1,
            braking: 0,
            steering: 0,
            suspensions: [ 'low', 'low', 'low', 'low' ],
            boosting: false,
            honking: false,
        },
    }, {
        isActive: () => true,
        sendFrame: () => true,
    })

    for(let tick = 1; tick <= 6; tick++)
        publisher.sample(tick)

    assert.equal(publisher.acknowledge(3), 3)
    assert.deepEqual(
        publisher.unacknowledgedInputs.map(({ sequence }) => sequence),
        [ 3, 4, 5 ],
    )
    assert.equal(publisher.acknowledge(3), 0)
})
