import { ProtocolError } from './protocol.js'
import { VERSIONS } from './versions.js'

const FRAME_HEADER_BYTES = 8
const TOKEN_DIGEST_BYTES = 32
const MAX_SUMMARY_BYTES = 64 * 1024

export const BENCHMARK_FRAME_TYPES = Object.freeze({
    SUMMARY_REQUEST: 9,
    SUMMARY: 10,
})

function bytes(value, label = 'benchmark frame')
{
    if(value instanceof Uint8Array)
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)
    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new ProtocolError(`${label} must be binary data`)
}

function fixedBytes(value, expectedLength, label)
{
    const source = bytes(value, label)
    if(source.byteLength !== expectedLength)
        throw new ProtocolError(`${label} must contain exactly ${expectedLength} bytes`)
    return source.slice()
}

function createFrame(frameType, payload)
{
    const body = bytes(payload, 'benchmark payload')
    const frame = new Uint8Array(FRAME_HEADER_BYTES + body.byteLength)
    const view = new DataView(frame.buffer)
    view.setUint8(0, frameType)
    view.setUint8(1, 0)
    view.setUint16(2, VERSIONS.protocolVersion, true)
    view.setUint32(4, body.byteLength, true)
    frame.set(body, FRAME_HEADER_BYTES)
    return frame
}

function decodeFrame(value, expectedFrameType, maximumPayloadBytes)
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
        throw new ProtocolError(`unexpected benchmark frame type ${frameType}`)
    if(flags !== 0)
        throw new ProtocolError('benchmark frame flags must be zero')
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
    if(payloadByteLength > maximumPayloadBytes)
        throw new ProtocolError(`benchmark payload exceeds ${maximumPayloadBytes} bytes`)

    return frame.slice(FRAME_HEADER_BYTES)
}

export async function digestBenchmarkToken(token)
{
    if(typeof token !== 'string' || token.length === 0)
        throw new TypeError('benchmark token must be a non-empty string')

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return new Uint8Array(digest)
}

export function encodeBenchmarkSummaryRequest({ tokenDigest })
{
    return createFrame(
        BENCHMARK_FRAME_TYPES.SUMMARY_REQUEST,
        fixedBytes(tokenDigest, TOKEN_DIGEST_BYTES, 'tokenDigest'),
    )
}

export function decodeBenchmarkSummaryRequest(value)
{
    const payload = decodeFrame(
        value,
        BENCHMARK_FRAME_TYPES.SUMMARY_REQUEST,
        TOKEN_DIGEST_BYTES,
    )
    if(payload.byteLength !== TOKEN_DIGEST_BYTES)
        throw new ProtocolError('benchmark summary request payload must contain exactly 32 bytes')
    return { tokenDigest: payload }
}

export function encodeBenchmarkSummary(summary)
{
    let json
    try
    {
        json = JSON.stringify(summary)
    }
    catch(error)
    {
        throw new ProtocolError('benchmark summary must be JSON serializable', error)
    }

    if(json === undefined)
        throw new ProtocolError('benchmark summary must be JSON serializable')

    const payload = new TextEncoder().encode(json)
    if(payload.byteLength > MAX_SUMMARY_BYTES)
        throw new ProtocolError(`benchmark summary exceeds ${MAX_SUMMARY_BYTES} bytes`)
    return createFrame(BENCHMARK_FRAME_TYPES.SUMMARY, payload)
}

export function decodeBenchmarkSummary(value)
{
    const payload = decodeFrame(
        value,
        BENCHMARK_FRAME_TYPES.SUMMARY,
        MAX_SUMMARY_BYTES,
    )

    try
    {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
    }
    catch(error)
    {
        throw new ProtocolError('benchmark summary must contain valid UTF-8 JSON', error)
    }
}
