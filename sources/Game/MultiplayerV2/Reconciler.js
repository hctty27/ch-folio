import { PredictionInputHistory } from './PredictionInputHistory.js'
import {
    tickAdd,
    tickAfter,
    tickDelta,
} from './TickMath.js'

const DEFAULT_MAX_ROLLBACK_TICKS = 60
const DEFAULT_CHECKPOINT_INTERVAL_TICKS = 2
const SOFT_POSITION_METERS = 0.05
const SOFT_ROTATION_RADIANS = Math.PI / 180
const SOFT_LINEAR_VELOCITY = 0.25
const SOFT_ANGULAR_VELOCITY = 0.10

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)
    return value
}

function copyEvent(event)
{
    return {
        tick: Number(event?.tick) >>> 0,
        type: Number(event?.type),
        entityOrder: Number(event?.entityOrder),
        spawnIndex: Number(event?.spawnIndex ?? 0xff),
        flags: Number(event?.flags ?? 0),
        value: Number(event?.value ?? 0),
    }
}

function eventKey(event)
{
    return `${event.tick}:${event.type}:${event.entityOrder}:${event.spawnIndex}:${event.flags}:${event.value}`
}

function vectorDistance(left, right)
{
    if(!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
        return Number.POSITIVE_INFINITY
    let squared = 0
    for(let index = 0; index < left.length; index++)
    {
        const delta = Number(left[index]) - Number(right[index])
        if(!Number.isFinite(delta))
            return Number.POSITIVE_INFINITY
        squared += delta * delta
    }
    return Math.sqrt(squared)
}

function quaternionAngle(left, right)
{
    if(!Array.isArray(left) || !Array.isArray(right) || left.length !== 4 || right.length !== 4)
        return Number.POSITIVE_INFINITY

    let dot = 0
    let leftLength = 0
    let rightLength = 0
    for(let index = 0; index < 4; index++)
    {
        const a = Number(left[index])
        const b = Number(right[index])
        if(!Number.isFinite(a) || !Number.isFinite(b))
            return Number.POSITIVE_INFINITY
        dot += a * b
        leftLength += a * a
        rightLength += b * b
    }
    if(leftLength <= Number.EPSILON || rightLength <= Number.EPSILON)
        return Number.POSITIVE_INFINITY

    const normalizedDot = Math.abs(dot / Math.sqrt(leftLength * rightLength))
    return 2 * Math.acos(Math.min(1, Math.max(-1, normalizedDot)))
}

function copyPhysicalState(state)
{
    if(!state)
        return null
    return {
        entityOrder: Number(state.entityOrder),
        position: [ ...state.position ],
        quaternion: [ ...state.quaternion ],
        linearVelocity: [ ...state.linearVelocity ],
        angularVelocity: [ ...state.angularVelocity ],
        lastConfirmedSequence: Number(state.lastConfirmedSequence ?? 0) >>> 0,
    }
}

export function localError(predicted, authoritative)
{
    if(!predicted || !authoritative)
    {
        return {
            position: Number.POSITIVE_INFINITY,
            rotation: Number.POSITIVE_INFINITY,
            linearVelocity: Number.POSITIVE_INFINITY,
            angularVelocity: Number.POSITIVE_INFINITY,
        }
    }

    return {
        position: vectorDistance(predicted.position, authoritative.position),
        rotation: quaternionAngle(predicted.quaternion, authoritative.quaternion),
        linearVelocity: vectorDistance(
            predicted.linearVelocity,
            authoritative.linearVelocity,
        ),
        angularVelocity: vectorDistance(
            predicted.angularVelocity,
            authoritative.angularVelocity,
        ),
    }
}

function insideSoftThresholds(error)
{
    return (
        error.position <= SOFT_POSITION_METERS
        && error.rotation <= SOFT_ROTATION_RADIANS
        && error.linearVelocity <= SOFT_LINEAR_VELOCITY
        && error.angularVelocity <= SOFT_ANGULAR_VELOCITY
    )
}

function normalizePredictionRecord(record, fallbackPredictionTick)
{
    if(!record || !Number.isInteger(record.entityOrder) || !record.input)
        throw new TypeError('prediction input record must contain entityOrder and input')
    return {
        predictionTick: Number(record.predictionTick ?? fallbackPredictionTick) >>> 0,
        entityOrder: record.entityOrder,
        input: record.input,
    }
}

function groupedPredictionInputs(records, startTick, endTick)
{
    const grouped = new Map()
    for(const record of records)
    {
        if(!tickAfter(record.predictionTick, startTick))
            continue
        if(tickAfter(record.predictionTick, endTick))
            continue
        const bucket = grouped.get(record.predictionTick) ?? []
        bucket.push({
            entityOrder: record.entityOrder,
            input: record.input,
        })
        grouped.set(record.predictionTick, bucket)
    }
    return grouped
}

export class Reconciler
{
    constructor({
        predictionWorld,
        localEntityOrder,
        maxRollbackTicks = DEFAULT_MAX_ROLLBACK_TICKS,
        checkpointIntervalTicks = DEFAULT_CHECKPOINT_INTERVAL_TICKS,
        requestFullSync = () => {},
        acknowledgeInput = () => {},
        reconcileVisuals = () => {},
    } = {})
    {
        if(!predictionWorld || typeof predictionWorld.step !== 'function')
            throw new TypeError('Reconciler requires a prediction world')
        for(const method of [
            'readState',
            'applyLocalAuthoritativeState',
            'captureFullSync',
            'restoreFullSync',
        ])
        {
            if(typeof predictionWorld[method] !== 'function')
                throw new TypeError(`prediction world must implement ${method}`)
        }
        if(typeof requestFullSync !== 'function')
            throw new TypeError('requestFullSync must be a function')
        if(typeof acknowledgeInput !== 'function')
            throw new TypeError('acknowledgeInput must be a function')
        if(typeof reconcileVisuals !== 'function')
            throw new TypeError('reconcileVisuals must be a function')

        this.predictionWorld = predictionWorld
        this.localEntityOrder = integer(localEntityOrder, 1, 8, 'localEntityOrder')
        this.maxRollbackTicks = integer(maxRollbackTicks, 1, 0xffff, 'maxRollbackTicks')
        this.checkpointIntervalTicks = integer(
            checkpointIntervalTicks,
            1,
            this.maxRollbackTicks,
            'checkpointIntervalTicks',
        )
        this.requestFullSync = requestFullSync
        this.acknowledgeInput = acknowledgeInput
        this.reconcileVisuals = reconcileVisuals

        this.inputs = new PredictionInputHistory(this.maxRollbackTicks)
        this.eventsByTick = new Map()
        this.predictedLocalStates = new Map()
        this.lastAuthoritativeTick = null
        this.lastAuthoritativeDiagnostics = null
        this.rollbackCount = 0
        this.hardSyncCount = 0
        this.destroyed = false

        if(typeof this.predictionWorld.setLocalEntityOrder === 'function')
        {
            this.predictionWorld.setLocalEntityOrder(this.localEntityOrder)
            if(typeof this.predictionWorld.retainLocalEntity === 'function')
                this.predictionWorld.retainLocalEntity()
        }
    }

    assertActive()
    {
        if(this.destroyed)
            throw new Error('Reconciler has been destroyed')
    }

    recordInputs(records, fallbackPredictionTick = tickAdd(this.predictionWorld.tick, 1))
    {
        if(!Array.isArray(records))
            throw new TypeError('inputs must be an array')
        for(const source of records)
            this.inputs.push(normalizePredictionRecord(source, fallbackPredictionTick))
    }

    recordEvents(events)
    {
        if(!Array.isArray(events))
            throw new TypeError('events must be an array')

        for(const source of events)
        {
            if(source?.entityOrder !== this.localEntityOrder)
                continue
            const event = copyEvent(source)
            const bucket = this.eventsByTick.get(event.tick) ?? new Map()
            bucket.set(eventKey(event), event)
            this.eventsByTick.set(event.tick, bucket)
        }
    }

    predict({ predictionTick = tickAdd(this.predictionWorld.tick, 1), inputs = [], events = [] } = {})
    {
        this.assertActive()
        const targetTick = Number(predictionTick) >>> 0
        const records = inputs.map((record) => normalizePredictionRecord(record, targetTick))
        this.recordInputs(records, targetTick)
        this.recordEvents(events)
        const tick = this.predictionWorld.step({
            inputs: records.map(({ entityOrder, input }) => ({ entityOrder, input })),
            events: events.filter((event) => event?.entityOrder === this.localEntityOrder),
        })
        this.captureTick()
        return tick
    }

    captureTick()
    {
        this.assertActive()
        const tick = this.predictionWorld.tick >>> 0
        const local = this.predictionWorld.readState(this.localEntityOrder)
        if(local)
            this.predictedLocalStates.set(tick, copyPhysicalState(local))

        for(const storedTick of this.predictedLocalStates.keys())
        {
            const age = tickDelta(tick, storedTick)
            if(age > this.maxRollbackTicks)
                this.predictedLocalStates.delete(storedTick)
        }
        for(const storedTick of this.eventsByTick.keys())
        {
            const age = tickDelta(tick, storedTick)
            if(age > this.maxRollbackTicks)
                this.eventsByTick.delete(storedTick)
        }
        return tick
    }

    eventsAt(tick)
    {
        return [ ...(this.eventsByTick.get(Number(tick) >>> 0)?.values() ?? []) ]
    }

    acknowledgeFrame(frame)
    {
        const local = frame.states.find((state) => state.entityOrder === this.localEntityOrder)
        if(!local)
            return null

        const confirmed = Number(local.lastConfirmedSequence) >>> 0
        const nextSequence = (confirmed + 1) >>> 0
        this.inputs.acknowledge(nextSequence)
        this.acknowledgeInput(nextSequence)
        return confirmed
    }

    hardSyncRequest(reason, serverTick, currentTick, error = null)
    {
        this.hardSyncCount++
        this.requestFullSync(reason)
        return {
            status: 'hard-sync-requested',
            reason,
            serverTick,
            currentTick,
            rolledBack: false,
            replayedTicks: 0,
            error,
        }
    }

    resetTimeline()
    {
        this.predictedLocalStates.clear()
        this.eventsByTick.clear()
    }

    replayPredictionTicks(startTick, endTick)
    {
        const tickCount = tickDelta(endTick, startTick)
        if(tickCount <= 0)
            return 0
        if(tickCount > this.maxRollbackTicks)
            throw new RangeError('prediction replay exceeds rollback window')

        const grouped = groupedPredictionInputs(
            this.inputs.afterPredictionTick(startTick),
            startTick,
            endTick,
        )
        let tick = startTick >>> 0
        for(let index = 0; index < tickCount; index++)
        {
            tick = tickAdd(tick, 1)
            this.predictionWorld.step({
                inputs: grouped.get(tick) ?? [],
                events: this.eventsAt(tick),
            })
            this.captureTick()
        }
        return tickCount
    }

    async reconcileState(frame)
    {
        this.assertActive()
        if(!frame || !Array.isArray(frame.states) || !Array.isArray(frame.events))
            throw new TypeError('state frame must contain states and events arrays')

        const serverTick = Number(frame.serverTick) >>> 0
        const currentTick = this.predictionWorld.tick >>> 0
        if(
            this.lastAuthoritativeTick !== null
            && !tickAfter(serverTick, this.lastAuthoritativeTick)
        )
        {
            return {
                status: 'stale',
                serverTick,
                currentTick,
                rolledBack: false,
                replayedTicks: 0,
                error: null,
            }
        }

        if(tickAfter(serverTick, currentTick))
            return this.hardSyncRequest('future-authoritative-state', serverTick, currentTick)

        this.recordEvents(frame.events)
        this.lastAuthoritativeDiagnostics = {
            serverTick,
            checksum32: Number(frame.checksum32) >>> 0,
            worldHash: frame.worldHash ?? null,
        }

        const authoritativeLocal = frame.states.find(
            (state) => state.entityOrder === this.localEntityOrder,
        )
        if(!authoritativeLocal)
            return this.hardSyncRequest('local-authoritative-state-missing', serverTick, currentTick)

        this.acknowledgeFrame(frame)
        const age = tickDelta(currentTick, serverTick)
        const predictedLocal = this.predictedLocalStates.get(serverTick)
        if(
            age < 0
            || age > this.maxRollbackTicks
            || predictedLocal === undefined
        )
        {
            return this.hardSyncRequest(
                'rollback-window-exceeded',
                serverTick,
                currentTick,
            )
        }

        const error = localError(predictedLocal, authoritativeLocal)
        if(insideSoftThresholds(error))
        {
            this.lastAuthoritativeTick = serverTick
            return {
                status: 'confirmed',
                serverTick,
                currentTick,
                rolledBack: false,
                replayedTicks: 0,
                error,
            }
        }

        const backup = this.predictionWorld.captureFullSync()
        const before = this.predictionWorld.readState()
        try
        {
            this.predictionWorld.applyLocalAuthoritativeState(authoritativeLocal, serverTick)
            this.predictedLocalStates.set(
                serverTick,
                copyPhysicalState(this.predictionWorld.readState(this.localEntityOrder)),
            )
            for(const storedTick of this.predictedLocalStates.keys())
            {
                if(tickAfter(storedTick, serverTick) && !tickAfter(storedTick, currentTick))
                    this.predictedLocalStates.delete(storedTick)
            }

            const replayedTicks = this.replayPredictionTicks(serverTick, currentTick)
            const after = this.predictionWorld.readState()
            this.reconcileVisuals(before, after, {
                hard: false,
                serverTick,
                currentTick,
            })
            this.rollbackCount++
            this.lastAuthoritativeTick = serverTick
            return {
                status: 'rolled-back',
                serverTick,
                currentTick,
                rolledBack: true,
                replayedTicks,
                error,
            }
        }
        catch
        {
            this.predictionWorld.restoreFullSync(backup)
            this.resetTimeline()
            this.captureTick()
            return this.hardSyncRequest('rollback-failed', serverTick, currentTick, error)
        }
    }

    applyFullSync(sync)
    {
        this.assertActive()
        const before = this.predictionWorld.readState()
        const previousTick = this.predictionWorld.tick >>> 0
        const serverTick = Number(sync?.serverTick) >>> 0

        this.predictionWorld.restoreFullSync(sync)
        const descriptor = sync.entities?.find(
            (entity) => entity.entityOrder === this.localEntityOrder,
        )
        if(descriptor)
        {
            const confirmed = Number(descriptor.lastConfirmedSequence) >>> 0
            const nextSequence = (confirmed + 1) >>> 0
            this.inputs.acknowledge(nextSequence)
            this.acknowledgeInput(nextSequence)
        }

        this.resetTimeline()
        this.captureTick()
        let replayedTicks = 0
        const ticksToReplay = tickDelta(previousTick, serverTick)
        if(ticksToReplay > 0 && ticksToReplay <= this.maxRollbackTicks)
            replayedTicks = this.replayPredictionTicks(serverTick, previousTick)

        const currentTick = this.predictionWorld.tick >>> 0
        const after = this.predictionWorld.readState()
        this.reconcileVisuals(before, after, {
            hard: true,
            serverTick,
            currentTick,
        })
        this.lastAuthoritativeTick = serverTick

        return {
            status: 'hard-synced',
            serverTick,
            currentTick,
            rolledBack: false,
            replayedTicks,
            error: null,
        }
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.destroyed = true
        this.inputs.clear()
        this.eventsByTick.clear()
        this.predictedLocalStates.clear()
    }
}
