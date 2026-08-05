import {
    ProtocolError,
    decodeFullSyncFrame as decodeFullSyncFrameRaw,
    decodeStateFrame as decodeStateFrameRaw,
    encodeFullSyncFrame as encodeFullSyncFrameRaw,
    encodeStateFrame as encodeStateFrameRaw,
} from './protocol.js'

const MAX_ENTITY_ORDER = 8

function assertEntityOrder(value, label)
{
    if(!Number.isInteger(value) || value < 1 || value > MAX_ENTITY_ORDER)
        throw new ProtocolError(`${label} must be an integer from 1 to ${MAX_ENTITY_ORDER}`)

    return value
}

function toWireRecord(record, label)
{
    return {
        ...record,
        entityOrder: assertEntityOrder(record?.entityOrder, label) - 1,
    }
}

function fromWireRecord(record)
{
    return {
        ...record,
        entityOrder: record.entityOrder + 1,
    }
}

function assertSortedEntityOrder(records, label)
{
    if(!Array.isArray(records))
        return

    let previous = 0

    for(const record of records)
    {
        const current = record?.entityOrder
        if(!Number.isInteger(current))
            return

        assertEntityOrder(current, `${label}.entityOrder`)
        if(current <= previous)
            throw new ProtocolError(`${label} must be sorted entityOrder in strictly increasing order`)

        previous = current
    }
}

function compareQueuedInputKeys(left, right)
{
    const leftTick = left?.input?.clientTick
    const rightTick = right?.input?.clientTick
    if(leftTick !== rightTick)
        return leftTick - rightTick

    const leftEntity = left?.entityOrder
    const rightEntity = right?.entityOrder
    if(leftEntity !== rightEntity)
        return leftEntity - rightEntity

    return left?.input?.sequence - right?.input?.sequence
}

function assertCanonicalQueuedInputs(records)
{
    if(!Array.isArray(records))
        return

    for(const record of records)
    {
        if(Number.isInteger(record?.entityOrder))
            assertEntityOrder(record.entityOrder, 'queuedInput.entityOrder')
    }

    for(let index = 1; index < records.length; index++)
    {
        const comparison = compareQueuedInputKeys(records[index - 1], records[index])
        if(!Number.isFinite(comparison))
            return

        if(comparison >= 0)
            throw new ProtocolError('queued inputs must use canonical order by clientTick, entityOrder, and sequence')
    }
}

export function encodeStateFrame(value)
{
    assertSortedEntityOrder(value?.states, 'states')
    return encodeStateFrameRaw({
        ...value,
        states: value?.states?.map((state) => toWireRecord(state, 'state.entityOrder')),
        events: value?.events?.map((event) => toWireRecord(event, 'event.entityOrder')),
    })
}

export function decodeStateFrame(value)
{
    const decoded = decodeStateFrameRaw(value)
    const converted = {
        ...decoded,
        states: decoded.states.map(fromWireRecord),
        events: decoded.events.map(fromWireRecord),
    }
    assertSortedEntityOrder(converted.states, 'states')
    return converted
}

export function encodeFullSyncFrame(value)
{
    assertSortedEntityOrder(value?.entities, 'entities')
    assertCanonicalQueuedInputs(value?.queuedInputs)
    return encodeFullSyncFrameRaw({
        ...value,
        entities: value?.entities?.map((entity) => toWireRecord(entity, 'entity.entityOrder')),
        queuedInputs: value?.queuedInputs?.map((queued) =>
            toWireRecord(queued, 'queuedInput.entityOrder')),
    })
}

export function decodeFullSyncFrame(value)
{
    const decoded = decodeFullSyncFrameRaw(value)
    const converted = {
        ...decoded,
        entities: decoded.entities.map(fromWireRecord),
        queuedInputs: decoded.queuedInputs.map(fromWireRecord),
    }
    assertSortedEntityOrder(converted.entities, 'entities')
    assertCanonicalQueuedInputs(converted.queuedInputs)
    return converted
}

export { AuthoritativeWorld } from './AuthoritativeWorld.js'

export {
    GRACE_TICKS,
    INPUT_BUFFER_TICKS,
    MAX_SLOTS,
    NO_SPAWN_INDEX,
    ROOM_EVENT_TYPES,
    ROOM_SLOT_STATES,
    RoomSimulation,
    SPAWN_CHECK_INTERVAL_TICKS,
} from './RoomSimulation.js'

export {
    checksum32,
    hashWorldSnapshot,
    readCanonicalState,
} from './canonicalState.js'

export {
    CheckpointRing,
    InputHistory,
} from './checkpoints.js'

export {
    dequantizeInput,
    packSuspensions,
    quantizeInput,
    resolveMissingInput,
    unpackSuspensions,
} from './input.js'

export {
    FRAME_HEADER_BYTES,
    FRAME_TYPES,
    INPUT_RECORD_BYTES,
    ProtocolError,
    STATE_RECORD_BYTES,
    decodeErrorFrame,
    decodeHello,
    decodeInputBatch,
    decodeResume,
    encodeErrorFrame,
    encodeHello,
    encodeInputBatch,
    encodeResume,
} from './protocol.js'

export {
    RAPIER_VERSION,
    VERSIONS,
    assertCompatibility,
} from './versions.js'

export {
    MAP_COLLISION_VERSION,
    SPAWN_APPROACH_HORIZON_SECONDS,
    SPAWN_COUNT,
    SPAWN_SAFETY_HALF_EXTENTS,
    loadAuthoritativeMap,
} from './map.js'

export {
    findSafeSpawn,
    isSpawnSafe,
} from './spawnPoints.js'

export { VEHICLE_CONFIG } from './vehicleConfig.js'
export {
    applyVehicleInput,
    createQuantizedInputFromPlayer,
} from './vehicleInput.js'
