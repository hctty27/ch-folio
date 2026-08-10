import {
    tickAfter,
    tickAtOrAfter,
    tickDelta,
} from './TickMath.js'

const DEFAULT_MAX_TICKS = 60
const MAX_ENTITY_ORDER = 8

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)
    return value
}

function uint32(value, label)
{
    return integer(value, 0, 0xffffffff, label)
}

function cloneInput(input)
{
    return {
        clientTick: uint32(input?.clientTick, 'input.clientTick'),
        sequence: uint32(input?.sequence, 'input.sequence'),
        throttle: integer(input?.throttle, 0, 0xff, 'input.throttle'),
        brake: integer(input?.brake, 0, 0xff, 'input.brake'),
        steering: integer(input?.steering, -0x8000, 0x7fff, 'input.steering'),
        suspensions: integer(input?.suspensions, 0, 0xff, 'input.suspensions'),
        flags: integer(input?.flags, 0, 0xff, 'input.flags'),
    }
}

function cloneRecord(record)
{
    return {
        predictionTick: uint32(record?.predictionTick, 'predictionTick'),
        entityOrder: integer(record?.entityOrder, 1, MAX_ENTITY_ORDER, 'entityOrder'),
        input: cloneInput(record?.input),
    }
}

function recordKey(record)
{
    return `${record.predictionTick}:${record.entityOrder}:${record.input.sequence}`
}

function compareRecords(left, right)
{
    const tickComparison = tickDelta(left.predictionTick, right.predictionTick)
    if(tickComparison !== 0)
        return tickComparison
    if(left.entityOrder !== right.entityOrder)
        return left.entityOrder - right.entityOrder
    return tickDelta(left.input.sequence, right.input.sequence)
}

export class PredictionInputHistory
{
    constructor(maxTicks = DEFAULT_MAX_TICKS)
    {
        this.maxTicks = integer(maxTicks, 1, 0xffff, 'maxTicks')
        this.records = new Map()
        this.latestPredictionTick = null
    }

    get size()
    {
        return this.records.size
    }

    push(value)
    {
        const record = cloneRecord(value)
        const key = recordKey(record)
        if(this.records.has(key))
            return false

        if(
            this.latestPredictionTick === null
            || tickAfter(record.predictionTick, this.latestPredictionTick)
        )
            this.latestPredictionTick = record.predictionTick
        else if(
            tickDelta(this.latestPredictionTick, record.predictionTick) >= this.maxTicks
        )
            return false

        this.records.set(key, record)
        this.#pruneOldTicks()
        return true
    }

    atPredictionTick(tick)
    {
        const target = uint32(tick, 'tick')
        const record = this.values().find((candidate) => candidate.predictionTick === target)
        return record ?? null
    }

    afterPredictionTick(tick)
    {
        const target = uint32(tick, 'tick')
        return this.values().filter((record) => tickAfter(record.predictionTick, target))
    }

    acknowledge(nextSequence)
    {
        const cursor = uint32(nextSequence, 'nextSequence')
        const before = this.records.size
        for(const [ key, record ] of this.records)
        {
            if(!tickAtOrAfter(record.input.sequence, cursor))
                this.records.delete(key)
        }
        this.#refreshLatestTick()
        return before - this.records.size
    }

    values()
    {
        return [ ...this.records.values() ]
            .sort(compareRecords)
            .map(cloneRecord)
    }

    clear()
    {
        this.records.clear()
        this.latestPredictionTick = null
    }

    #pruneOldTicks()
    {
        if(this.latestPredictionTick === null)
            return
        for(const [ key, record ] of this.records)
        {
            if(tickDelta(this.latestPredictionTick, record.predictionTick) >= this.maxTicks)
                this.records.delete(key)
        }
    }

    #refreshLatestTick()
    {
        if(this.records.size === 0)
        {
            this.latestPredictionTick = null
            return
        }

        let latest = this.records.values().next().value.predictionTick
        for(const record of this.records.values())
        {
            if(tickAfter(record.predictionTick, latest))
                latest = record.predictionTick
        }
        this.latestPredictionTick = latest
    }
}
