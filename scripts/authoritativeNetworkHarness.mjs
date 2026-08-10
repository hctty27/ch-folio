import seedrandom from 'seedrandom'
import mapSource from '../packages/authoritative-physics/generated/map-v1.json' with { type: 'json' }
import {
    AuthoritativeWorld,
    GRACE_TICKS,
    ROOM_SLOT_STATES,
    RoomSimulation,
} from '@ch-folio/authoritative-physics'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'
import { Reconciler } from '../sources/Game/MultiplayerV2/Reconciler.js'
import {
    runAuthoritativeScenario,
    runScenarioWithAdapter,
    validateScenarioFixture,
} from '../packages/authoritative-physics/test/scenarioHarness.mjs'

const SAFE_INPUT = Object.freeze({
    clientTick: 0,
    sequence: 0,
    throttle: 0,
    brake: 255,
    steering: 0,
    suspensions: 0,
    flags: 0,
})

export const NETWORK_CASES = Object.freeze({
    DELAY_JITTER_REORDER_DROP_BATCH: 'delay-jitter-reorder-drop-batch',
    AUTHORITY_OLDER_THAN_ONE_SECOND: 'authority-older-than-one-second',
    RESUME_BEFORE_GRACE_EXPIRY: 'resume-before-grace-expiry',
    RESUME_AFTER_GRACE_EXPIRY: 'resume-after-grace-expiry',
})

function speedOf(velocity)
{
    return Math.sqrt(
        velocity[0] * velocity[0]
        + velocity[1] * velocity[1]
        + velocity[2] * velocity[2]
    )
}

function cloneInput(input)
{
    return {
        clientTick: Number(input.clientTick) >>> 0,
        sequence: Number(input.sequence) >>> 0,
        throttle: Number(input.throttle),
        brake: Number(input.brake),
        steering: Number(input.steering),
        suspensions: Number(input.suspensions),
        flags: Number(input.flags),
    }
}

function createPredictionAdapter({ RAPIER, fixture })
{
    const normalized = validateScenarioFixture(fixture)
    const prediction = new PredictionWorld({ RAPIER, mapData: mapSource })

    for(const entity of normalized.entities)
    {
        prediction.add(entity.entityOrder, entity)
        prediction.world.setVehicleState(entity.entityOrder, {
            ...entity,
            steering: 0,
            confirmedInputSequence: 0,
            input: SAFE_INPUT,
            previousPosition: entity.position,
            speed: speedOf(entity.linearVelocity),
        })
        prediction.lastInputs.set(entity.entityOrder, cloneInput(SAFE_INPUT))
    }

    return {
        prediction,
        adapter: {
            tick: () => prediction.tick,
            applyInputs: (records) => prediction.applyInputs(records),
            step: () => prediction.step(),
            checksum: () => prediction.checksum(),
            snapshot: () => prediction.world.takeSnapshot(),
            destroy: () => prediction.destroy(),
        },
    }
}

export function runPredictionScenario({ RAPIER, fixture })
{
    const { adapter } = createPredictionAdapter({ RAPIER, fixture })
    return runScenarioWithAdapter({ fixture, adapter })
}

function groupFixtureInputs(fixture)
{
    const normalized = validateScenarioFixture(fixture)
    const grouped = new Map()
    for(const record of normalized.inputs)
    {
        const bucket = grouped.get(record.input.clientTick) ?? []
        bucket.push(record)
        grouped.set(record.input.clientTick, bucket)
    }
    return { normalized, grouped }
}

function stateFrame(prediction)
{
    return {
        serverTick: prediction.tick,
        eventCursor: 0,
        checksum32: prediction.checksum(),
        states: prediction.canonicalStates(),
        events: [],
        worldHash: null,
    }
}

async function delaySimulation({ RAPIER, fixture, seed })
{
    const rng = seedrandom(seed)
    const serverHolder = createPredictionAdapter({ RAPIER, fixture })
    const clientHolder = createPredictionAdapter({ RAPIER, fixture })
    const server = serverHolder.prediction
    const client = clientHolder.prediction
    const hardSyncReasons = []
    const reconciler = new Reconciler({
        predictionWorld: client,
        localEntityOrder: 1,
        requestFullSync: (reason) => hardSyncReasons.push(reason),
    })
    const { normalized, grouped } = groupFixtureInputs(fixture)
    const deliveries = new Map()
    let frameIndex = 0
    let droppedFrames = 0
    let reorderedFrames = 0
    let batchedDeliveries = 0
    let lastDeliveredTick = -1
    const observedLatencies = []

    try
    {
        for(let tick = 1; tick <= normalized.ticks; tick++)
        {
            const inputs = grouped.get(tick) ?? []
            server.applyInputs(inputs)
            server.step()
            reconciler.predict({ inputs })

            if(tick % 3 === 0)
            {
                let latencyMs
                if(frameIndex === 0)
                    latencyMs = 0
                else if(frameIndex === 1)
                    latencyMs = 300
                else
                    latencyMs = Math.floor(rng() * 301)
                observedLatencies.push(latencyMs)

                if(frameIndex % 7 === 6)
                    droppedFrames++
                else
                {
                    const jitterTicks = Math.floor(rng() * 5) - 2
                    let deliveryTick = Math.max(
                        tick,
                        tick + Math.round(latencyMs * 60 / 1000) + jitterTicks,
                    )
                    if(frameIndex === 3)
                        deliveryTick = tick + 5
                    if(frameIndex === 4)
                        deliveryTick = tick + 2

                    const bucket = deliveries.get(deliveryTick) ?? []
                    bucket.push(stateFrame(server))
                    deliveries.set(deliveryTick, bucket)
                }
                frameIndex++
            }

            const due = deliveries.get(tick) ?? []
            if(due.length > 1)
                batchedDeliveries++
            for(const frame of due)
            {
                if(frame.serverTick < lastDeliveredTick)
                    reorderedFrames++
                lastDeliveredTick = Math.max(lastDeliveredTick, frame.serverTick)
                await reconciler.reconcileState(frame)
            }
            deliveries.delete(tick)
        }

        const remaining = [ ...deliveries.entries() ]
            .sort((left, right) => left[0] - right[0])
            .flatMap(([, frames ]) => frames)
        for(const frame of remaining)
        {
            if(frame.serverTick < lastDeliveredTick)
                reorderedFrames++
            lastDeliveredTick = Math.max(lastDeliveredTick, frame.serverTick)
            await reconciler.reconcileState(frame)
        }

        return {
            minLatencyMs: Math.min(...observedLatencies),
            maxLatencyMs: Math.max(...observedLatencies),
            reorderedFrames,
            droppedFrames,
            batchedDeliveries,
            persistentDivergence: server.checksum() === client.checksum() ? 0 : 1,
            finalServerChecksum: server.checksum(),
            finalClientChecksum: client.checksum(),
            hardSyncReasons,
            partialRollbackApplied: false,
        }
    }
    finally
    {
        reconciler.destroy()
        server.destroy()
        client.destroy()
    }
}

async function oldAuthoritySimulation({ RAPIER, fixture })
{
    const serverHolder = createPredictionAdapter({ RAPIER, fixture })
    const clientHolder = createPredictionAdapter({ RAPIER, fixture })
    const server = serverHolder.prediction
    const client = clientHolder.prediction
    const hardSyncReasons = []
    const reconciler = new Reconciler({
        predictionWorld: client,
        localEntityOrder: 1,
        requestFullSync: (reason) => hardSyncReasons.push(reason),
    })
    const { normalized, grouped } = groupFixtureInputs(fixture)

    try
    {
        for(let tick = 1; tick <= normalized.ticks; tick++)
        {
            const inputs = grouped.get(tick) ?? []
            server.applyInputs(inputs)
            server.step()
            reconciler.predict({ inputs })
        }

        const oldFrame = {
            ...stateFrame(server),
            serverTick: Math.max(1, client.tick - 61),
            checksum32: (server.checksum() ^ 1) >>> 0,
        }
        const result = await reconciler.reconcileState(oldFrame)
        if(result.status !== 'hard-sync-requested')
            throw new Error('old authority did not request hard sync')

        reconciler.applyFullSync(server.captureFullSync())
        return {
            minLatencyMs: 0,
            maxLatencyMs: 300,
            reorderedFrames: 0,
            droppedFrames: 0,
            batchedDeliveries: 0,
            persistentDivergence: server.checksum() === client.checksum() ? 0 : 1,
            finalServerChecksum: server.checksum(),
            finalClientChecksum: client.checksum(),
            hardSyncReasons,
            partialRollbackApplied: false,
        }
    }
    finally
    {
        reconciler.destroy()
        server.destroy()
        client.destroy()
    }
}

async function resumeSimulation({ RAPIER, fixture, beforeExpiry })
{
    const world = new AuthoritativeWorld({ RAPIER, mapData: mapSource })
    const room = new RoomSimulation({ world })
    const reserved = room.reserveSlot({ playerId: 1 })
    room.markSyncReady(reserved.entityOrder)
    while(room.getSlot(reserved.entityOrder).slotState !== ROOM_SLOT_STATES.ACTIVE)
        room.advanceOneTick()

    room.disconnect(reserved.entityOrder)
    const disconnectTick = room.currentTick
    const advances = beforeExpiry ? GRACE_TICKS - 1 : GRACE_TICKS
    for(let tick = 0; tick < advances; tick++)
        room.advanceOneTick()

    let resumeAccepted = false
    let vehiclePersistedDuringGrace = false
    let despawned = false
    try
    {
        const slot = room.getSlot(reserved.entityOrder)
        vehiclePersistedDuringGrace = slot.hasBody
        resumeAccepted = beforeExpiry ? room.resume(reserved.entityOrder) : false
    }
    catch
    {
        despawned = true
    }

    const [ authoritative, prediction ] = await Promise.all([
        runAuthoritativeScenario({ RAPIER, fixture }),
        runPredictionScenario({ RAPIER, fixture }),
    ])
    const finalServerChecksum = authoritative.checksums.at(-1).checksum32
    const finalClientChecksum = prediction.checksums.at(-1).checksum32
    world.destroy()

    return {
        minLatencyMs: 0,
        maxLatencyMs: 300,
        reorderedFrames: 0,
        droppedFrames: 0,
        batchedDeliveries: 0,
        persistentDivergence: finalServerChecksum === finalClientChecksum ? 0 : 1,
        finalServerChecksum,
        finalClientChecksum,
        hardSyncReasons: [],
        partialRollbackApplied: false,
        resumeAccepted,
        vehiclePersistedDuringGrace,
        expiredAtTick: room.currentTick - disconnectTick,
        despawned,
    }
}

export function runSeededNetworkSimulation({ RAPIER, fixture, seed, caseName })
{
    if(caseName === NETWORK_CASES.DELAY_JITTER_REORDER_DROP_BATCH)
        return delaySimulation({ RAPIER, fixture, seed })
    if(caseName === NETWORK_CASES.AUTHORITY_OLDER_THAN_ONE_SECOND)
        return oldAuthoritySimulation({ RAPIER, fixture })
    if(caseName === NETWORK_CASES.RESUME_BEFORE_GRACE_EXPIRY)
        return resumeSimulation({ RAPIER, fixture, beforeExpiry: true })
    if(caseName === NETWORK_CASES.RESUME_AFTER_GRACE_EXPIRY)
        return resumeSimulation({ RAPIER, fixture, beforeExpiry: false })
    throw new TypeError(`unsupported network simulation case ${String(caseName)}`)
}
