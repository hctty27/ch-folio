import {
    CheckpointRing,
    InputHistory,
    hashWorldSnapshot,
} from '@ch-folio/authoritative-physics'

const DEFAULT_MAX_ROLLBACK_TICKS = 60
const DEFAULT_CHECKPOINT_INTERVAL_TICKS = 2

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

function bytesEqual(left, right)
{
    if(!(left instanceof Uint8Array) || !(right instanceof Uint8Array))
        return false
    if(left.byteLength !== right.byteLength)
        return false

    for(let index = 0; index < left.byteLength; index++)
    {
        if(left[index] !== right[index])
            return false
    }
    return true
}

function groupInputsByTick(records)
{
    const grouped = new Map()
    for(const record of records)
    {
        const tick = record.input.clientTick >>> 0
        const bucket = grouped.get(tick) ?? []
        bucket.push(record)
        grouped.set(tick, bucket)
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
            'checksum',
            'createCheckpoint',
            'restoreCheckpoint',
            'applyStateFrame',
            'captureFullSync',
            'restoreFullSync',
            'readState',
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

        this.checkpoints = new CheckpointRing(
            Math.ceil(this.maxRollbackTicks / this.checkpointIntervalTicks) + 1,
        )
        this.inputs = new InputHistory(this.maxRollbackTicks)
        this.eventsByTick = new Map()
        this.checksums = new Map()
        this.lastAuthoritativeTick = null
        this.destroyed = false
    }

    assertActive()
    {
        if(this.destroyed)
            throw new Error('Reconciler has been destroyed')
    }

    recordInputs(records)
    {
        if(!Array.isArray(records))
            throw new TypeError('inputs must be an array')
        for(const record of records)
            this.inputs.push(record)
    }

    recordEvents(events)
    {
        if(!Array.isArray(events))
            throw new TypeError('events must be an array')

        for(const source of events)
        {
            const event = copyEvent(source)
            const bucket = this.eventsByTick.get(event.tick) ?? new Map()
            bucket.set(eventKey(event), event)
            this.eventsByTick.set(event.tick, bucket)
        }
    }

    predict({ inputs = [], events = [] } = {})
    {
        this.assertActive()
        this.recordInputs(inputs)
        this.recordEvents(events)
        const tick = this.predictionWorld.step({ inputs, events })
        this.captureTick()
        return tick
    }

    captureTick()
    {
        this.assertActive()
        const tick = this.predictionWorld.tick >>> 0
        this.checksums.set(tick, this.predictionWorld.checksum())

        if(tick % this.checkpointIntervalTicks === 0)
            this.checkpoints.push(this.predictionWorld.createCheckpoint())

        const oldest = Math.max(0, tick - this.maxRollbackTicks)
        for(const storedTick of this.checksums.keys())
        {
            if(storedTick < oldest)
                this.checksums.delete(storedTick)
        }
        for(const storedTick of this.eventsByTick.keys())
        {
            if(storedTick < oldest)
                this.eventsByTick.delete(storedTick)
        }
        return tick
    }

    eventsAt(tick)
    {
        return [ ...(this.eventsByTick.get(tick)?.values() ?? []) ]
    }

    acknowledgeFrame(frame)
    {
        const local = frame.states.find((state) => state.entityOrder === this.localEntityOrder)
        if(!local)
            return null

        const confirmed = Number(local.lastConfirmedSequence) >>> 0
        this.acknowledgeInput((confirmed + 1) >>> 0)
        return confirmed
    }

    hardSyncRequest(reason, serverTick, currentTick)
    {
        this.requestFullSync(reason)
        return {
            status: 'hard-sync-requested',
            reason,
            serverTick,
            currentTick,
        }
    }

    async verifyWorldHash(worldHash)
    {
        if(worldHash === null || worldHash === undefined)
            return true

        const hashTick = Number(worldHash.hashTick) >>> 0
        const checkpoint = this.checkpoints.findAtOrBefore(hashTick)
        if(!checkpoint || checkpoint.tick !== hashTick)
            return true

        const localHash = await hashWorldSnapshot(checkpoint.snapshot)
        return bytesEqual(localHash, worldHash.sha256)
    }

    resetTimeline()
    {
        this.checkpoints.clear()
        this.checksums.clear()
    }

    replayRange(startTick, endTick)
    {
        if(endTick <= startTick)
            return 0

        const groupedInputs = groupInputsByTick(this.inputs.after(startTick))
        let replayedTicks = 0

        for(let tick = startTick + 1; tick <= endTick; tick++)
        {
            this.predictionWorld.step({
                inputs: groupedInputs.get(tick) ?? [],
                events: this.eventsAt(tick),
            })
            this.captureTick()
            replayedTicks++
        }

        return replayedTicks
    }

    async reconcileState(frame)
    {
        this.assertActive()
        if(!frame || !Array.isArray(frame.states) || !Array.isArray(frame.events))
            throw new TypeError('state frame must contain states and events arrays')

        const serverTick = Number(frame.serverTick) >>> 0
        const currentTick = this.predictionWorld.tick >>> 0

        if(this.lastAuthoritativeTick !== null && serverTick <= this.lastAuthoritativeTick)
        {
            return {
                status: 'stale',
                serverTick,
                currentTick,
                rolledBack: false,
            }
        }

        if(serverTick > currentTick)
            return this.hardSyncRequest('future-authoritative-state', serverTick, currentTick)

        this.recordEvents(frame.events)
        if(!await this.verifyWorldHash(frame.worldHash))
            return this.hardSyncRequest('world-hash-mismatch', serverTick, currentTick)

        this.acknowledgeFrame(frame)
        const localChecksum = this.checksums.get(serverTick)
        if(localChecksum === (Number(frame.checksum32) >>> 0))
        {
            this.lastAuthoritativeTick = serverTick
            return {
                status: 'confirmed',
                serverTick,
                currentTick,
                rolledBack: false,
            }
        }

        if(
            currentTick - serverTick > this.maxRollbackTicks
            || localChecksum === undefined
        )
        {
            return this.hardSyncRequest(
                'rollback-window-exceeded',
                serverTick,
                currentTick,
            )
        }

        const baseTick = Math.max(0, serverTick - 1)
        const baseCheckpoint = this.checkpoints.findAtOrBefore(baseTick)
        if(!baseCheckpoint)
        {
            return this.hardSyncRequest(
                'rollback-checkpoint-unavailable',
                serverTick,
                currentTick,
            )
        }

        const backup = this.predictionWorld.captureFullSync()
        const before = this.predictionWorld.readState()

        try
        {
            this.predictionWorld.restoreCheckpoint(baseCheckpoint)
            this.resetTimeline()
            this.captureTick()
            this.replayRange(baseCheckpoint.tick, baseTick)
            this.predictionWorld.applyStateFrame(frame)
            if(this.predictionWorld.checksum() !== (Number(frame.checksum32) >>> 0))
                throw new Error('authoritative state checksum did not round-trip')

            this.captureTick()
            const replayedTicks = this.replayRange(serverTick, currentTick)
            const after = this.predictionWorld.readState()
            this.reconcileVisuals(before, after, {
                hard: false,
                serverTick,
                currentTick,
            })
            this.lastAuthoritativeTick = serverTick

            return {
                status: 'rolled-back',
                serverTick,
                currentTick,
                replayedTicks,
            }
        }
        catch(error)
        {
            this.predictionWorld.restoreFullSync(backup)
            this.resetTimeline()
            this.captureTick()
            return this.hardSyncRequest('rollback-failed', serverTick, currentTick)
        }
    }

    applyFullSync(sync)
    {
        this.assertActive()
        const before = this.predictionWorld.readState()
        const previousTick = this.predictionWorld.tick >>> 0
        const serverTick = Number(sync?.serverTick) >>> 0

        this.predictionWorld.restoreFullSync(sync)
        this.recordInputs(sync.queuedInputs ?? [])
        this.resetTimeline()
        this.captureTick()

        while(this.predictionWorld.tick < serverTick)
        {
            this.predictionWorld.step({ events: this.eventsAt(this.predictionWorld.tick + 1) })
            this.captureTick()
        }

        const currentTick = Math.max(previousTick, serverTick)
        const replayedTicks = this.replayRange(serverTick, currentTick)
        const descriptor = sync.entities?.find(
            (entity) => entity.entityOrder === this.localEntityOrder,
        )
        if(descriptor)
        {
            const confirmed = Number(descriptor.lastConfirmedSequence) >>> 0
            this.acknowledgeInput((confirmed + 1) >>> 0)
        }

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
            replayedTicks,
        }
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.destroyed = true
        this.checkpoints.clear()
        this.inputs.clear()
        this.eventsByTick.clear()
        this.checksums.clear()
    }
}
