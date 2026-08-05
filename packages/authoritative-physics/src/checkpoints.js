const DEFAULT_CHECKPOINT_CAPACITY = 30
const DEFAULT_INPUT_TICK_CAPACITY = 60
const MAX_ENTITIES = 8

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)

    return value
}

function uint8(value, label)
{
    return integer(value, 0, 0xff, label)
}

function uint16(value, label)
{
    return integer(value, 0, 0xffff, label)
}

function uint32(value, label)
{
    return integer(value, 0, 0xffffffff, label)
}

function int16(value, label)
{
    return integer(value, -0x8000, 0x7fff, label)
}

function entityOrder(value, label = 'entityOrder')
{
    return integer(value, 1, MAX_ENTITIES, label)
}

function capacity(value, label)
{
    return integer(value, 1, 0xffff, label)
}

function copyBytes(value, label)
{
    if(value instanceof Uint8Array)
        return Uint8Array.from(value)

    if(value instanceof ArrayBuffer)
        return new Uint8Array(value.slice(0))

    if(ArrayBuffer.isView(value))
    {
        return Uint8Array.from(new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength,
        ))
    }

    throw new TypeError(`${label} must be binary data`)
}

function cloneEntityDescriptor(entity, index)
{
    const label = `entities[${index}]`
    return {
        entityOrder: entityOrder(entity?.entityOrder, `${label}.entityOrder`),
        slotState: uint8(entity?.slotState, `${label}.slotState`),
        spawnIndex: uint8(entity?.spawnIndex, `${label}.spawnIndex`),
        flags: uint8(entity?.flags, `${label}.flags`),
        playerId: uint32(entity?.playerId, `${label}.playerId`),
        lastConfirmedSequence: uint32(
            entity?.lastConfirmedSequence,
            `${label}.lastConfirmedSequence`,
        ),
        controllerOffset: uint16(entity?.controllerOffset, `${label}.controllerOffset`),
        controllerLength: uint16(entity?.controllerLength, `${label}.controllerLength`),
    }
}

function sortedUnique(records, label)
{
    records.sort((left, right) => left.entityOrder - right.entityOrder)

    for(let index = 1; index < records.length; index++)
    {
        if(records[index - 1].entityOrder === records[index].entityOrder)
            throw new TypeError(`${label} contains duplicate entityOrder ${records[index].entityOrder}`)
    }

    return records
}

function cloneConfirmedSequence(record, index)
{
    const label = `confirmedSequences[${index}]`
    return {
        entityOrder: entityOrder(record?.entityOrder, `${label}.entityOrder`),
        sequence: uint32(record?.sequence, `${label}.sequence`),
    }
}

function cloneCheckpoint(value)
{
    if(!Array.isArray(value?.entities) || value.entities.length > MAX_ENTITIES)
        throw new TypeError('checkpoint entities must contain at most eight records')

    if(!Array.isArray(value?.confirmedSequences) || value.confirmedSequences.length > MAX_ENTITIES)
        throw new TypeError('checkpoint confirmedSequences must contain at most eight records')

    const controllerMetadata = copyBytes(value.controllerMetadata, 'controllerMetadata')
    const entities = sortedUnique(
        value.entities.map(cloneEntityDescriptor),
        'checkpoint entities',
    )

    for(const entity of entities)
    {
        if(entity.controllerOffset + entity.controllerLength > controllerMetadata.byteLength)
        {
            throw new TypeError(
                `entityOrder ${entity.entityOrder} controller metadata range is out of bounds`,
            )
        }
    }

    return {
        tick: uint32(value?.tick, 'checkpoint tick'),
        snapshot: copyBytes(value?.snapshot, 'snapshot'),
        entities,
        controllerMetadata,
        confirmedSequences: sortedUnique(
            value.confirmedSequences.map(cloneConfirmedSequence),
            'checkpoint confirmedSequences',
        ),
        eventCursor: uint32(value?.eventCursor, 'eventCursor'),
    }
}

export class CheckpointRing
{
    constructor(maxCheckpoints = DEFAULT_CHECKPOINT_CAPACITY)
    {
        this.maxCheckpoints = capacity(maxCheckpoints, 'maxCheckpoints')
        this.checkpoints = []
    }

    get size()
    {
        return this.checkpoints.length
    }

    push(checkpoint)
    {
        const stored = cloneCheckpoint(checkpoint)
        const latest = this.checkpoints.at(-1)

        if(latest && stored.tick <= latest.tick)
            throw new TypeError('checkpoint ticks must be strictly increasing')

        this.checkpoints.push(stored)
        if(this.checkpoints.length > this.maxCheckpoints)
            this.checkpoints.shift()

        return cloneCheckpoint(stored)
    }

    oldest()
    {
        return this.checkpoints.length === 0
            ? null
            : cloneCheckpoint(this.checkpoints[0])
    }

    latest()
    {
        return this.checkpoints.length === 0
            ? null
            : cloneCheckpoint(this.checkpoints.at(-1))
    }

    findAtOrBefore(tick)
    {
        const target = uint32(tick, 'tick')

        for(let index = this.checkpoints.length - 1; index >= 0; index--)
        {
            if(this.checkpoints[index].tick <= target)
                return cloneCheckpoint(this.checkpoints[index])
        }

        return null
    }

    values()
    {
        return this.checkpoints.map(cloneCheckpoint)
    }

    clear()
    {
        this.checkpoints.length = 0
    }
}

function suspensionBits(value, label)
{
    const packed = uint8(value, label)

    for(let wheelIndex = 0; wheelIndex < 4; wheelIndex++)
    {
        if(((packed >>> (wheelIndex * 2)) & 0b11) === 0b11)
            throw new TypeError(`${label} contains an invalid wheel state`)
    }

    return packed
}

function cloneInputRecord(value)
{
    const input = value?.input
    return {
        entityOrder: entityOrder(value?.entityOrder),
        input: {
            clientTick: uint32(input?.clientTick, 'input.clientTick'),
            sequence: uint32(input?.sequence, 'input.sequence'),
            throttle: uint8(input?.throttle, 'input.throttle'),
            brake: uint8(input?.brake, 'input.brake'),
            steering: int16(input?.steering, 'input.steering'),
            suspensions: suspensionBits(input?.suspensions, 'input.suspensions'),
            flags: uint8(input?.flags, 'input.flags'),
        },
    }
}

function compareInputs(left, right)
{
    if(left.input.clientTick !== right.input.clientTick)
        return left.input.clientTick - right.input.clientTick

    if(left.entityOrder !== right.entityOrder)
        return left.entityOrder - right.entityOrder

    return left.input.sequence - right.input.sequence
}

function inputKey(record)
{
    return `${record.input.clientTick}:${record.entityOrder}:${record.input.sequence}`
}

export class InputHistory
{
    constructor(maxTicks = DEFAULT_INPUT_TICK_CAPACITY)
    {
        this.maxTicks = capacity(maxTicks, 'maxTicks')
        this.records = new Map()
        this.maximumTick = null
    }

    get size()
    {
        return this.records.size
    }

    get tickCount()
    {
        return new Set(
            [ ...this.records.values() ].map((record) => record.input.clientTick),
        ).size
    }

    get oldestTick()
    {
        if(this.records.size === 0)
            return null

        return Math.min(...[ ...this.records.values() ].map((record) => record.input.clientTick))
    }

    get latestTick()
    {
        return this.maximumTick
    }

    push(value)
    {
        const record = cloneInputRecord(value)
        const tick = record.input.clientTick

        if(this.maximumTick === null || tick > this.maximumTick)
            this.maximumTick = tick

        const oldestRetainedTick = Math.max(0, this.maximumTick - this.maxTicks + 1)
        if(tick < oldestRetainedTick)
            return false

        const key = inputKey(record)
        if(this.records.has(key))
            return false

        this.records.set(key, record)

        for(const [ existingKey, existing ] of this.records)
        {
            if(existing.input.clientTick < oldestRetainedTick)
                this.records.delete(existingKey)
        }

        return true
    }

    values()
    {
        return [ ...this.records.values() ]
            .sort(compareInputs)
            .map(cloneInputRecord)
    }

    after(tick)
    {
        const target = uint32(tick, 'tick')
        return this.values().filter((record) => record.input.clientTick > target)
    }

    pruneThrough(tick)
    {
        const target = uint32(tick, 'tick')

        for(const [ key, record ] of this.records)
        {
            if(record.input.clientTick <= target)
                this.records.delete(key)
        }

        if(this.records.size === 0)
            this.maximumTick = null
        else
            this.maximumTick = Math.max(...[ ...this.records.values() ].map((record) => record.input.clientTick))
    }

    clear()
    {
        this.records.clear()
        this.maximumTick = null
    }
}
