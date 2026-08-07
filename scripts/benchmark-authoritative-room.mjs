import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import mapSource from '../packages/authoritative-physics/generated/map-v1.json' with { type: 'json' }
import pileupFixture from '../packages/authoritative-physics/test/fixtures/eight-car-pileup.json' with { type: 'json' }
import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { validateScenarioFixture } from '../packages/authoritative-physics/test/scenarioHarness.mjs'
import {
    AuthoritativeWorld,
    RAPIER_VERSION,
    ROOM_SLOT_STATES,
    VERSIONS,
    checksum32,
    decodeInputBatch,
    decodeStateFrame,
    encodeInputBatch,
    encodeStateFrame,
    hashWorldSnapshot,
    readCanonicalState,
} from '@ch-folio/authoritative-physics'

const DEFAULT_TICKS = 36_000
const DEFAULT_SLOW_TICK_THRESHOLD_MS = 5
const SAMPLE_INTERVAL_TICKS = 3
const HASH_INTERVAL_TICKS = 60
const SAFE_INPUT = Object.freeze({
    clientTick: 0,
    sequence: 0,
    throttle: 128,
    brake: 255,
    steering: 0,
    suspensions: 0,
    flags: 0,
})
const RAPIER_TIMING_METHODS = Object.freeze({
    rapierBroadPhase: 'timingBroadPhase',
    rapierNarrowPhase: 'timingNarrowPhase',
    rapierCcd: 'timingCcd',
    rapierSolver: 'timingSolver',
})

function percentile(sorted, ratio)
{
    if(sorted.length === 0)
        return 0
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

export function summarizeSamples(values)
{
    if(!Array.isArray(values) || values.some((value) => !Number.isFinite(value) || value < 0))
        throw new TypeError('benchmark samples must be finite non-negative numbers')

    const sorted = [ ...values ].sort((left, right) => left - right)
    const totalMs = sorted.reduce((total, value) => total + value, 0)
    return {
        count: sorted.length,
        totalMs,
        meanMs: sorted.length === 0 ? 0 : totalMs / sorted.length,
        p50Ms: percentile(sorted, 0.50),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted.at(-1) ?? 0,
    }
}

function finiteMetric(value)
{
    return Number.isFinite(value) ? Number(value) : Number.POSITIVE_INFINITY
}

export function evaluateBenchmarkGates(report)
{
    const failures = []
    const gates = [
        [ 'totalTick.p95Ms', finiteMetric(report?.phases?.totalTick?.p95Ms), 8 ],
        [ 'totalTick.p99Ms', finiteMetric(report?.phases?.totalTick?.p99Ms), 12 ],
        [ 'totalTick.maxMs', finiteMetric(report?.phases?.totalTick?.maxMs), 16.67 ],
        [ 'gauges.maxQueueDepth', finiteMetric(report?.gauges?.maxQueueDepth), 3 ],
        [ 'divergence.persistent', finiteMetric(report?.divergence?.persistent), 0 ],
    ]

    for(const [ gate, actual, limit ] of gates)
    {
        if(actual > limit)
            failures.push({ gate, actual, limit })
    }

    return { pass: failures.length === 0, failures }
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

function speedOf(velocity)
{
    return Math.sqrt(
        velocity[0] * velocity[0]
        + velocity[1] * velocity[1]
        + velocity[2] * velocity[2]
    )
}

function createWorld(RAPIER, normalized)
{
    const world = new AuthoritativeWorld({ RAPIER, mapData: mapSource })
    const lastInputs = new Map()

    for(const entity of normalized.entities)
    {
        world.addVehicle(entity.entityOrder, entity)
        world.setVehicleState(entity.entityOrder, {
            ...entity,
            steering: 0,
            confirmedInputSequence: 0,
            input: SAFE_INPUT,
            previousPosition: entity.position,
            speed: speedOf(entity.linearVelocity),
        })
        lastInputs.set(entity.entityOrder, cloneInput(SAFE_INPUT))
    }

    return { world, lastInputs }
}

function canonicalStates(world, lastInputs)
{
    return readCanonicalState([ ...world.vehicles.keys() ]
        .sort((left, right) => left - right)
        .map((entityOrder) =>
        {
            const state = world.readVehicleState(entityOrder)
            const input = lastInputs.get(entityOrder) ?? SAFE_INPUT
            return {
                entityOrder,
                stateFlags: ROOM_SLOT_STATES.ACTIVE,
                collisionFlags: 0,
                suspensions: input.suspensions,
                lastConfirmedSequence: state.confirmedInputSequence >>> 0,
                position: state.position,
                quaternion: state.quaternion,
                linearVelocity: state.linearVelocity,
                angularVelocity: state.angularVelocity,
                steering: input.steering,
                wheelRotations: [ 0, 0, 0, 0 ],
                controlFlags: 0,
                throttle: input.throttle,
                brake: input.brake,
                inputFlags: input.flags,
            }
        }))
}

function groupInputs(normalized)
{
    const grouped = new Map()
    for(const record of normalized.inputs)
    {
        const tick = record.input.clientTick
        const bucket = grouped.get(tick) ?? []
        bucket.push(record)
        grouped.set(tick, bucket)
    }
    return grouped
}

function record(samples, phase, durationMs)
{
    const values = samples.get(phase) ?? []
    values.push(Math.max(0, durationMs))
    samples.set(phase, values)
}

function readRssBytes()
{
    if(typeof process.memoryUsage.rss === 'function')
        return process.memoryUsage.rss()
    return process.memoryUsage().rss
}

function recordRapierInternalTimings(world, samples)
{
    for(const [ phase, methodName ] of Object.entries(RAPIER_TIMING_METHODS))
    {
        const method = world.world?.[methodName]
        if(typeof method !== 'function')
            continue
        const value = Number(method.call(world.world))
        if(Number.isFinite(value) && value >= 0)
            record(samples, phase, value)
    }
}

function validateSlowTickThreshold(value)
{
    if(!Number.isFinite(value) || value < 0)
        throw new TypeError('slowTickThresholdMs must be a finite non-negative number')
    return Number(value)
}

export async function runLocalBenchmark({
    ticks = DEFAULT_TICKS,
    diagnostics = false,
    slowTickThresholdMs = DEFAULT_SLOW_TICK_THRESHOLD_MS,
    rapier = null,
} = {})
{
    if(!Number.isSafeInteger(ticks) || ticks < 1)
        throw new TypeError('ticks must be a positive safe integer')
    if(typeof diagnostics !== 'boolean')
        throw new TypeError('diagnostics must be a boolean')
    const diagnosticThreshold = validateSlowTickThreshold(slowTickThresholdMs)

    const normalized = validateScenarioFixture(pileupFixture)
    const inputsByFixtureTick = groupInputs(normalized)
    const RAPIER = rapier ?? await loadRapierForNode()
    const primary = createWorld(RAPIER, normalized)
    const shadow = createWorld(RAPIER, normalized)
    const samples = new Map()
    const slowTicks = []
    let checksumMismatches = 0
    let hashMismatches = 0
    let peakRssBytes = readRssBytes()
    let rapierStepMs = 0

    const rawRapierStep = primary.world.world.step.bind(primary.world.world)
    primary.world.world.step = (...args) =>
    {
        const started = performance.now()
        const result = rawRapierStep(...args)
        rapierStepMs += performance.now() - started
        return result
    }

    const wallStarted = performance.now()
    try
    {
        for(let tick = 1; tick <= ticks; tick++)
        {
            const tickStarted = performance.now()
            const tickCpuStarted = diagnostics ? process.cpuUsage() : null
            const tickResourceStarted = diagnostics ? process.resourceUsage() : null
            const fixtureTick = ((tick - 1) % normalized.ticks) + 1
            const records = inputsByFixtureTick.get(fixtureTick) ?? []

            for(const recordInput of records)
            {
                const input = {
                    ...cloneInput(recordInput.input),
                    clientTick: tick >>> 0,
                    sequence: tick >>> 0,
                }

                const encodeStarted = performance.now()
                const encoded = encodeInputBatch([ input ])
                record(samples, 'inputEncode', performance.now() - encodeStarted)

                const decodeStarted = performance.now()
                const [ decoded ] = decodeInputBatch(encoded)
                record(samples, 'inputDecode', performance.now() - decodeStarted)

                primary.world.setInput(recordInput.entityOrder, decoded)
                shadow.world.setInput(recordInput.entityOrder, decoded)
                primary.lastInputs.set(recordInput.entityOrder, cloneInput(decoded))
                shadow.lastInputs.set(recordInput.entityOrder, cloneInput(decoded))
            }

            rapierStepMs = 0
            const simulationStarted = performance.now()
            const advanced = primary.world.step()
            const simulationMs = performance.now() - simulationStarted
            if(advanced !== tick)
                throw new Error(`primary world advanced to unexpected tick ${advanced}`)
            record(samples, 'rapierStep', rapierStepMs)
            record(samples, 'controllerUpdate', Math.max(0, simulationMs - rapierStepMs))
            recordRapierInternalTimings(primary.world, samples)

            let primaryChecksum = null
            let primarySnapshot = null
            if(tick % SAMPLE_INTERVAL_TICKS === 0)
            {
                const checksumStarted = performance.now()
                const states = canonicalStates(primary.world, primary.lastInputs)
                primaryChecksum = checksum32(states) >>> 0
                record(samples, 'checksum', performance.now() - checksumStarted)

                const encodeStarted = performance.now()
                const stateFrame = encodeStateFrame({
                    serverTick: tick,
                    eventCursor: 0,
                    checksum32: primaryChecksum,
                    states,
                    events: [],
                    worldHash: null,
                })
                record(samples, 'stateEncode', performance.now() - encodeStarted)

                const decodeStarted = performance.now()
                const decodedState = decodeStateFrame(stateFrame)
                record(samples, 'stateDecode', performance.now() - decodeStarted)
                if(decodedState.checksum32 !== primaryChecksum)
                    throw new Error('state codec changed the benchmark checksum')
            }

            if(tick % HASH_INTERVAL_TICKS === 0)
            {
                const snapshotStarted = performance.now()
                primarySnapshot = Uint8Array.from(primary.world.takeSnapshot())
                record(samples, 'snapshot', performance.now() - snapshotStarted)
            }

            const tickEnded = performance.now()
            const totalTickMs = tickEnded - tickStarted
            record(samples, 'totalTick', totalTickMs)
            if(diagnostics && totalTickMs >= diagnosticThreshold)
            {
                const cpu = process.cpuUsage(tickCpuStarted)
                const resourceEnded = process.resourceUsage()
                const cpuUserMs = cpu.user / 1000
                const cpuSystemMs = cpu.system / 1000
                slowTicks.push({
                    tick,
                    fixtureTick,
                    startTimeMs: tickStarted,
                    endTimeMs: tickEnded,
                    totalMs: totalTickMs,
                    cpuUserMs,
                    cpuSystemMs,
                    cpuTotalMs: cpuUserMs + cpuSystemMs,
                    voluntaryContextSwitchesDelta: Math.max(
                        0,
                        resourceEnded.voluntaryContextSwitches
                            - tickResourceStarted.voluntaryContextSwitches,
                    ),
                    involuntaryContextSwitchesDelta: Math.max(
                        0,
                        resourceEnded.involuntaryContextSwitches
                            - tickResourceStarted.involuntaryContextSwitches,
                    ),
                })
            }

            const shadowAdvanced = shadow.world.step()
            if(shadowAdvanced !== tick)
                throw new Error(`shadow world advanced to unexpected tick ${shadowAdvanced}`)

            if(primaryChecksum !== null)
            {
                const shadowChecksum = checksum32(canonicalStates(shadow.world, shadow.lastInputs)) >>> 0
                if(primaryChecksum !== shadowChecksum)
                    checksumMismatches++
            }

            if(primarySnapshot !== null)
            {
                const shadowSnapshot = Uint8Array.from(shadow.world.takeSnapshot())
                const hashStarted = performance.now()
                const [ primaryHash, shadowHash ] = await Promise.all([
                    hashWorldSnapshot(primarySnapshot),
                    hashWorldSnapshot(shadowSnapshot),
                ])
                record(samples, 'hashDigest', performance.now() - hashStarted)
                if(primaryHash.length !== shadowHash.length
                    || primaryHash.some((value, index) => value !== shadowHash[index]))
                    hashMismatches++
            }

            if(tick % HASH_INTERVAL_TICKS === 0 || tick === ticks)
                peakRssBytes = Math.max(peakRssBytes, readRssBytes())
        }
    }
    finally
    {
        primary.world.destroy()
        shadow.world.destroy()
    }

    const phases = Object.fromEntries([ ...samples.entries() ]
        .sort(([ left ], [ right ]) => left.localeCompare(right))
        .map(([ phase, values ]) => [ phase, summarizeSamples(values) ]))
    const report = {
        schemaVersion: 1,
        mode: 'local-node',
        metadata: {
            fixture: normalized.id,
            ticks,
            tickRateHz: 60,
            logicalDurationSeconds: ticks / 60,
            vehicles: normalized.entities.length,
            nodeVersion: process.version,
            rapierVersion: RAPIER_VERSION,
            versions: VERSIONS,
            startedAt: new Date().toISOString(),
            wallDurationMs: performance.now() - wallStarted,
        },
        phases,
        gauges: {
            queueDepth: 0,
            maxQueueDepth: 0,
        },
        disconnects: 0,
        divergence: {
            checksumMismatches,
            hashMismatches,
            persistent: checksumMismatches + hashMismatches,
        },
        memory: {
            scope: 'node-process-rss',
            peakRssBytes,
        },
    }
    if(diagnostics)
    {
        report.diagnostics = {
            slowTickThresholdMs: diagnosticThreshold,
            slowTicks,
        }
    }
    report.gates = evaluateBenchmarkGates(report)
    return report
}

function parseCli(argv)
{
    const options = {
        ticks: DEFAULT_TICKS,
        output: null,
        diagnostics: false,
        slowTickThresholdMs: DEFAULT_SLOW_TICK_THRESHOLD_MS,
    }
    for(const argument of argv)
    {
        if(argument.startsWith('--ticks='))
            options.ticks = Number(argument.slice('--ticks='.length))
        else if(argument.startsWith('--output='))
            options.output = argument.slice('--output='.length)
        else if(argument === '--diagnostics')
            options.diagnostics = true
        else if(argument.startsWith('--slow-tick-threshold-ms='))
            options.slowTickThresholdMs = Number(argument.slice('--slow-tick-threshold-ms='.length))
        else
            throw new Error(`unknown benchmark argument ${argument}`)
    }
    return options
}

async function main()
{
    try
    {
        const options = parseCli(process.argv.slice(2))
        const report = await runLocalBenchmark({
            ticks: options.ticks,
            diagnostics: options.diagnostics,
            slowTickThresholdMs: options.slowTickThresholdMs,
        })
        const json = `${JSON.stringify(report, null, 2)}\n`
        if(options.output)
            await writeFile(options.output, json)
        process.stdout.write(json)
        if(!report.gates.pass)
            process.exitCode = 1
    }
    catch(error)
    {
        process.stderr.write(`${JSON.stringify({
            schemaVersion: 1,
            mode: 'local-node',
            error: error instanceof Error ? error.message : String(error),
        })}\n`)
        process.exitCode = 1
    }
}

const isMain = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if(isMain)
    await main()
