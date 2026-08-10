import { readFile } from 'node:fs/promises'
import seedrandom from 'seedrandom'

import {
    quantizeInput,
} from '@ch-folio/authoritative-physics'
import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { scenarioFixtures } from '../packages/authoritative-physics/test/scenarioCatalog.js'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'
import { Reconciler, localError } from '../sources/Game/MultiplayerV2/Reconciler.js'
import {
    tickAdd,
    tickAfter,
    tickDelta,
} from '../sources/Game/MultiplayerV2/TickMath.js'
import { TickSynchronizer } from '../sources/Game/MultiplayerV2/TickSynchronizer.js'

const RAPIER = await loadRapierForNode()
const mapData = JSON.parse(await readFile(
    new URL('../packages/authoritative-physics/generated/map-v1.json', import.meta.url),
    'utf8',
))
const TICK_MS = 1000 / 60
const STATE_INTERVAL_TICKS = 3
const INPUT_BATCH_TICKS = 3
const MAX_COMMAND_LEAD_TICKS = 18

function delayMs(rng, rttMs, jitterMs)
{
    const jitter = (rng() * 2 - 1) * jitterMs
    return Math.max(0, rttMs * 0.5 + jitter)
}

function pushDelivery(queue, atMs, value)
{
    queue.push({ atMs, value })
}

function takeDue(queue, nowMs)
{
    const due = []
    const pending = []
    for(const delivery of queue)
    {
        if(delivery.atMs <= nowMs)
            due.push(delivery)
        else
            pending.push(delivery)
    }
    due.sort((left, right) => left.atMs - right.atMs)
    queue.length = 0
    queue.push(...pending)
    return due
}

function cloneInput(input)
{
    return {
        clientTick: input.clientTick >>> 0,
        sequence: input.sequence >>> 0,
        throttle: input.throttle,
        brake: input.brake,
        steering: input.steering,
        suspensions: input.suspensions,
        flags: input.flags,
    }
}

function drivingInput(predictionTick, sequence)
{
    const phase = predictionTick % 240
    const steering = phase < 60
        ? 0.15
        : phase < 120
            ? -0.15
            : 0
    return quantizeInput({
        clientTick: tickAdd(predictionTick, -3),
        sequence,
        throttle: 0.75,
        brake: 0,
        steering,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    })
}

function stateFrame(world)
{
    return {
        serverTick: world.tick >>> 0,
        eventCursor: world.eventCursor >>> 0,
        checksum32: world.checksum(),
        states: world.canonicalStates(),
        events: [],
        worldHash: null,
    }
}

async function runOwnerPredictionHealth({ durationTicks, rttMs, jitterMs, seed })
{
    const rng = seedrandom(`${seed}:owner`)
    const server = new PredictionWorld({ RAPIER, mapData })
    const client = new PredictionWorld({ RAPIER, mapData })
    let hardSyncCount = 0
    server.add(1, mapData.spawns[0])
    const reconciler = new Reconciler({
        predictionWorld: client,
        localEntityOrder: 1,
        requestFullSync: () => hardSyncCount++,
    })
    reconciler.applyFullSync(server.captureFullSync())
    const deliveries = []

    try
    {
        for(let tick = 1; tick <= durationTicks; tick++)
        {
            const input = drivingInput(tick, tick)
            const record = { entityOrder: 1, input }
            server.step({ inputs: [ record ] })
            reconciler.predict({
                predictionTick: tick,
                inputs: [ { predictionTick: tick, ...record } ],
            })

            if(tick % STATE_INTERVAL_TICKS === 0 || tick === durationTicks)
            {
                pushDelivery(
                    deliveries,
                    tick * TICK_MS + delayMs(rng, rttMs, jitterMs),
                    stateFrame(server),
                )
            }

            for(const delivery of takeDue(deliveries, tick * TICK_MS))
                await reconciler.reconcileState(delivery.value)
        }

        deliveries.sort((left, right) => left.atMs - right.atMs)
        for(const delivery of deliveries)
            await reconciler.reconcileState(delivery.value)

        return {
            rollbackCount: reconciler.rollbackCount,
            hardSyncCount,
        }
    }
    finally
    {
        reconciler.destroy()
        server.destroy()
        client.destroy()
    }
}

function simulateAdaptiveCommandStream({
    durationTicks,
    warmupTicks,
    rttMs,
    jitterMs,
    seed,
})
{
    const rng = seedrandom(`${seed}:commands`)
    const synchronizer = new TickSynchronizer()
    const baseServerTick = 1000
    synchronizer.reset(baseServerTick, 0)

    let generatedPredictionTick = baseServerTick
    let sequence = 0
    let lastConfirmedSequence = null
    let lastConsumedCommandTick = tickAdd(baseServerTick, -3)
    let lateInputs = 0
    let measuredTicks = 0
    let futureLeadMaxTicks = 0
    let staleInputMax = 0
    const pendingBatch = []
    const inputDeliveries = []
    const stateDeliveries = []
    const serverInputs = new Map()

    const flushBatch = (nowMs) =>
    {
        if(pendingBatch.length === 0)
            return
        const batch = pendingBatch.splice(0, pendingBatch.length)
        const arrivalMs = nowMs + delayMs(rng, rttMs, jitterMs)
        for(const record of batch)
        {
            synchronizer.recordSent(record.sequence, record.commandTick, nowMs)
            pushDelivery(inputDeliveries, arrivalMs, record)
        }
    }

    const generateTowardTarget = (nowMs) =>
    {
        const targetTick = synchronizer.desiredPredictionTick(nowMs)
        let generated = 0
        while(
            tickAfter(targetTick, generatedPredictionTick)
            && generated < MAX_COMMAND_LEAD_TICKS
        )
        {
            generatedPredictionTick = tickAdd(generatedPredictionTick, 1)
            pendingBatch.push({
                predictionTick: generatedPredictionTick,
                commandTick: tickAdd(generatedPredictionTick, -3),
                sequence: sequence++ >>> 0,
            })
            if(pendingBatch.length >= INPUT_BATCH_TICKS)
                flushBatch(nowMs)
            generated++
        }
    }

    generateTowardTarget(0)
    for(let step = 1; step <= durationTicks; step++)
    {
        const nowMs = step * TICK_MS
        const serverTick = tickAdd(baseServerTick, step)
        const commandTick = tickAdd(serverTick, -3)

        for(const delivery of takeDue(inputDeliveries, nowMs))
        {
            const record = delivery.value
            if(tickDelta(record.commandTick, lastConsumedCommandTick) <= 0)
                continue
            serverInputs.set(record.commandTick, record)
            futureLeadMaxTicks = Math.max(
                futureLeadMaxTicks,
                tickDelta(record.commandTick, lastConsumedCommandTick),
            )
        }

        const consumed = serverInputs.get(commandTick)
        if(consumed)
        {
            serverInputs.delete(commandTick)
            lastConfirmedSequence = consumed.sequence
        }
        else if(step > warmupTicks)
            lateInputs++
        lastConsumedCommandTick = commandTick

        for(const queuedTick of [ ...serverInputs.keys() ])
        {
            if(tickDelta(queuedTick, lastConsumedCommandTick) <= 0)
                serverInputs.delete(queuedTick)
        }
        staleInputMax = Math.max(staleInputMax, 0)

        if(step % STATE_INTERVAL_TICKS === 0)
        {
            pushDelivery(stateDeliveries, nowMs + delayMs(rng, rttMs, jitterMs), {
                serverTick,
                lastConfirmedSequence,
            })
        }

        for(const delivery of takeDue(stateDeliveries, nowMs))
        {
            const state = delivery.value
            synchronizer.observeState(state.serverTick, delivery.atMs)
            if(state.lastConfirmedSequence !== null)
            {
                synchronizer.acknowledge(
                    state.lastConfirmedSequence,
                    state.serverTick,
                    delivery.atMs,
                )
            }
        }

        generateTowardTarget(nowMs)
        if(step > warmupTicks)
            measuredTicks++
    }
    flushBatch(durationTicks * TICK_MS)

    return {
        lateInputRate: measuredTicks === 0 ? 0 : lateInputs / measuredTicks,
        commandLeadTicks: synchronizer.commandLeadTicks,
        futureLeadMaxTicks,
        staleInputMax,
        clockDiscontinuities: synchronizer.clockDiscontinuities,
    }
}

export async function runV2NetworkDrivingMatrix({
    durationTicks = 600,
    warmupTicks = 180,
    rtts = [ 20, 60, 100, 150 ],
    jitters = [ 0, 10, 30 ],
    seed = 'v2-network-driving',
} = {})
{
    const results = []
    for(const rttMs of rtts)
    {
        for(const jitterMs of jitters)
        {
            const timing = simulateAdaptiveCommandStream({
                durationTicks,
                warmupTicks,
                rttMs,
                jitterMs,
                seed: `${seed}:${rttMs}:${jitterMs}`,
            })
            const prediction = await runOwnerPredictionHealth({
                durationTicks,
                rttMs,
                jitterMs,
                seed: `${seed}:${rttMs}:${jitterMs}`,
            })
            results.push({
                rttMs,
                jitterMs,
                ...timing,
                ...prediction,
            })
        }
    }
    return results
}

function speedOf(velocity)
{
    return Math.hypot(velocity[0], velocity[1], velocity[2])
}

function initializeFixtureWorld(fixture)
{
    const world = new PredictionWorld({ RAPIER, mapData })
    const safeInput = {
        clientTick: 0,
        sequence: 0,
        throttle: 128,
        brake: 255,
        steering: 0,
        suspensions: 0,
        flags: 0,
    }
    for(const entity of fixture.entities)
    {
        world.add(entity.entityOrder, entity)
        world.world.setVehicleState(entity.entityOrder, {
            ...entity,
            steering: 0,
            confirmedInputSequence: 0,
            input: safeInput,
            previousPosition: entity.position,
            speed: speedOf(entity.linearVelocity),
        })
        world.lastInputs.set(entity.entityOrder, cloneInput(safeInput))
    }
    return world
}

function fixtureInputsByTick(fixture)
{
    const grouped = new Map()
    for(const record of fixture.inputs)
    {
        const tick = record.input.clientTick >>> 0
        const bucket = grouped.get(tick) ?? []
        bucket.push(record)
        grouped.set(tick, bucket)
    }
    return grouped
}

function collisionFixture(name)
{
    const id = name === 'head-on' ? 'high-head-on' : name
    const found = scenarioFixtures.find(({ fixture }) => fixture.id === id)
    if(!found)
        throw new TypeError(`unsupported collision fixture ${String(name)}`)
    return found.fixture
}

export async function runTwoClientCollisionScenario({
    collision = 'head-on',
    rttMs = 60,
    jitterMs = 10,
    seed = 'v2-two-client-collision',
} = {})
{
    const fixture = collisionFixture(collision)
    const server = initializeFixtureWorld(fixture)
    const sync = server.captureFullSync()
    const inputGroups = fixtureInputsByTick(fixture)
    const clients = [ 1, 2 ].map((entityOrder) =>
    {
        const predictionWorld = new PredictionWorld({ RAPIER, mapData })
        let hardSyncCount = 0
        const reconciler = new Reconciler({
            predictionWorld,
            localEntityOrder: entityOrder,
            requestFullSync: () => hardSyncCount++,
        })
        reconciler.applyFullSync(sync)
        return {
            entityOrder,
            predictionWorld,
            reconciler,
            hardSyncCount: () => hardSyncCount,
            deliveries: [],
            rng: seedrandom(`${seed}:${entityOrder}`),
        }
    })

    try
    {
        for(let tick = 1; tick <= fixture.ticks; tick++)
        {
            const inputs = inputGroups.get(tick) ?? []
            server.step({ inputs })
            for(const client of clients)
            {
                const localInputs = inputs
                    .filter((record) => record.entityOrder === client.entityOrder)
                    .map((record) => ({
                        predictionTick: tick,
                        entityOrder: record.entityOrder,
                        input: record.input,
                    }))
                client.reconciler.predict({
                    predictionTick: tick,
                    inputs: localInputs,
                })
            }

            if(tick % STATE_INTERVAL_TICKS === 0 || tick === fixture.ticks)
            {
                const frame = stateFrame(server)
                for(const client of clients)
                {
                    pushDelivery(
                        client.deliveries,
                        tick * TICK_MS + delayMs(client.rng, rttMs, jitterMs),
                        frame,
                    )
                }
            }

            for(const client of clients)
            {
                for(const delivery of takeDue(client.deliveries, tick * TICK_MS))
                    await client.reconciler.reconcileState(delivery.value)
            }
        }

        for(const client of clients)
        {
            client.deliveries.sort((left, right) => left.atMs - right.atMs)
            for(const delivery of client.deliveries)
                await client.reconciler.reconcileState(delivery.value)
        }

        const clientResults = clients.map((client) =>
        {
            const error = localError(
                client.predictionWorld.readState(client.entityOrder),
                server.readState(client.entityOrder),
            )
            return {
                entityOrder: client.entityOrder,
                rollbackCount: client.reconciler.rollbackCount,
                hardSyncCount: client.hardSyncCount(),
                error,
            }
        })
        const authoritativeConvergence = clientResults.every(({ error }) =>
            error.position <= 0.05
            && error.rotation <= Math.PI / 180
            && error.linearVelocity <= 0.25
            && error.angularVelocity <= 0.10)

        return {
            collision,
            rttMs,
            jitterMs,
            clients: clientResults,
            authoritativeConvergence,
        }
    }
    finally
    {
        for(const client of clients)
        {
            client.reconciler.destroy()
            client.predictionWorld.destroy()
        }
        server.destroy()
    }
}
