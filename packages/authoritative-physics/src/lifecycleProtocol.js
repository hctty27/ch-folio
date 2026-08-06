import { ProtocolError } from './protocol.js'
import { VERSIONS } from './versions.js'

const FRAME_HEADER_BYTES = 8

export const LIFECYCLE_FRAME_TYPES = Object.freeze({
    SYNC_READY: 7,
    FULL_SYNC_REQUEST: 8,
})

function bytes(value)
{
    if(value instanceof Uint8Array)
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)
    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new ProtocolError('lifecycle frame must be binary data')
}

function encode(frameType)
{
    const frame = new Uint8Array(FRAME_HEADER_BYTES)
    const view = new DataView(frame.buffer)
    view.setUint8(0, frameType)
    view.setUint8(1, 0)
    view.setUint16(2, VERSIONS.protocolVersion, true)
    view.setUint32(4, 0, true)
    return frame
}

function decode(value, expectedFrameType)
{
    const frame = bytes(value)
    if(frame.byteLength < FRAME_HEADER_BYTES)
        throw new ProtocolError(`frame is shorter than the ${FRAME_HEADER_BYTES}-byte header`)

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const frameType = view.getUint8(0)
    const flags = view.getUint8(1)
    const protocolVersion = view.getUint16(2, true)
    const payloadByteLength = view.getUint32(4, true)

    if(frameType !== expectedFrameType)
        throw new ProtocolError(`unexpected lifecycle frame type ${frameType}`)
    if(flags !== 0)
        throw new ProtocolError('lifecycle frame flags must be zero')
    if(protocolVersion !== VERSIONS.protocolVersion)
    {
        throw new ProtocolError(
            `incompatible protocolVersion: expected ${VERSIONS.protocolVersion}, received ${protocolVersion}`,
        )
    }
    if(payloadByteLength !== frame.byteLength - FRAME_HEADER_BYTES)
    {
        throw new ProtocolError(
            `payload length mismatch: header ${payloadByteLength}, actual ${frame.byteLength - FRAME_HEADER_BYTES}`,
        )
    }
    if(payloadByteLength !== 0)
        throw new ProtocolError('lifecycle frame payload length must be zero')

    return { protocolVersion }
}

export function encodeSyncReady()
{
    return encode(LIFECYCLE_FRAME_TYPES.SYNC_READY)
}

export function decodeSyncReady(value)
{
    return decode(value, LIFECYCLE_FRAME_TYPES.SYNC_READY)
}

export function encodeFullSyncRequest()
{
    return encode(LIFECYCLE_FRAME_TYPES.FULL_SYNC_REQUEST)
}

export function decodeFullSyncRequest(value)
{
    return decode(value, LIFECYCLE_FRAME_TYPES.FULL_SYNC_REQUEST)
}
