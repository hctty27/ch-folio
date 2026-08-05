import {
    ProtocolError,
    decodeFullSyncFrame as decodeFullSyncFrameRaw,
    decodeStateFrame as decodeStateFrameRaw,
    encodeFullSyncFrame as encodeFullSyncFrameRaw,
    encodeStateFrame as encodeStateFrameRaw,
} from './protocol.js'

function assertSortedEntityOrder(records, label)
{
    if(!Array.isArray(records))
        return

    let previous = -1

    for(const record of records)
    {
        const current = record?.entityOrder
        if(!Number.isInteger(current))
            return

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
    return encodeStateFrameRaw(value)
}

export function decodeStateFrame(value)
{
    const decoded = decodeStateFrameRaw(value)
    assertSortedEntityOrder(decoded.states, 'states')
    return decoded
}

export function encodeFullSyncFrame(value)
{
    assertSortedEntityOrder(value?.entities, 'entities')
    assertCanonicalQueuedInputs(value?.queuedInputs)
    return encodeFullSyncFrameRaw(value)
}

export function decodeFullSyncFrame(value)
{
    const decoded = decodeFullSyncFrameRaw(value)
    assertSortedEntityOrder(decoded.entities, 'entities')
    assertCanonicalQueuedInputs(decoded.queuedInputs)
    return decoded
}

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
