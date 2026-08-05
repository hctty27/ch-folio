import { decode, encode } from '@msgpack/msgpack'

export const PROTOCOL_VERSION = 1
export const MAX_CLIENT_MESSAGES_PER_SECOND = 30
export const MAX_MESSAGE_BYTES = 4096

export const MESSAGE_TYPES = {
    WELCOME: 'welcome',
    JOINED: 'joined',
    STATE: 'state',
    LEFT: 'left',
    PING: 'ping',
    PONG: 'pong',
    ERROR: 'error',
} as const

export const STATE_FLAGS = {
    BRAKING: 1,
    BOOSTING: 2,
    HONKING: 4,
    STEERING_LEFT: 8,
    STEERING_RIGHT: 16,
} as const

const STATE_FLAG_MASK = Object.values(STATE_FLAGS).reduce((mask, flag) => mask | flag, 0)

export interface StateMessage
{
    v: number
    t: typeof MESSAGE_TYPES.STATE
    seq: number
    ts: number
    p: [number, number, number]
    q: [number, number, number, number]
    st: number
    sp: number
    f: number
}

export interface PlayerStateMessage extends StateMessage
{
    id: string
}

export interface SocketAttachment
{
    playerId: string
    room: string
    lastSequence: number
    latestState: StateMessage | null
    windowStartedAt: number
    messagesInWindow: number
}

export interface RateLimitResult
{
    allowed: boolean
    attachment: SocketAttachment
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value))

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, name: string): number
{
    if(typeof value !== 'number' || !Number.isFinite(value))
        throw new TypeError(`${name} must be finite`)

    return value
}

function finiteTuple<const T extends number>(
    value: unknown,
    length: T,
    name: string,
): number[]
{
    if(!Array.isArray(value) || value.length !== length)
        throw new TypeError(`${name} must contain ${length} values`)

    return value.map((item, index) => finiteNumber(item, `${name}[${index}]`))
}

function normalizeQuaternion(value: unknown): [number, number, number, number]
{
    const quaternion = finiteTuple(value, 4, 'quaternion')
    const length = Math.hypot(...quaternion)

    if(length < 1e-8)
        throw new TypeError('quaternion must have a non-zero length')

    return quaternion.map((component) => component / length) as [number, number, number, number]
}

export function normalizeRoom(value: string | null | undefined): string
{
    const normalized = String(value ?? 'public')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .slice(0, 64)

    return normalized || 'public'
}

export function createSocketAttachment(
    playerId: string,
    room: string,
    now: number,
): SocketAttachment
{
    return {
        playerId,
        room: normalizeRoom(room),
        lastSequence: -1,
        latestState: null,
        windowStartedAt: now,
        messagesInWindow: 0,
    }
}

export function sanitizeClientState(
    input: unknown,
    now: number,
    lastSequence: number,
): StateMessage
{
    if(!isRecord(input))
        throw new TypeError('message must be an object')
    if(input.v !== PROTOCOL_VERSION)
        throw new TypeError('unsupported protocol version')
    if(input.t !== MESSAGE_TYPES.STATE)
        throw new TypeError('unsupported message type')

    const sequence = finiteNumber(input.seq, 'sequence')
    if(!Number.isInteger(sequence) || sequence < 0)
        throw new TypeError('sequence must be a non-negative integer')
    if(sequence <= lastSequence)
        throw new TypeError('sequence must be newer than the previous state')

    const position = finiteTuple(input.p, 3, 'position')
        .map((component) => clamp(component, -10000, 10000)) as [number, number, number]

    return {
        v: PROTOCOL_VERSION,
        t: MESSAGE_TYPES.STATE,
        seq: sequence,
        ts: Math.trunc(now),
        p: position,
        q: normalizeQuaternion(input.q),
        st: clamp(finiteNumber(input.st, 'steering'), -1, 1),
        sp: clamp(finiteNumber(input.sp, 'forwardSpeed'), -100, 100),
        f: Math.trunc(finiteNumber(input.f, 'flags')) & STATE_FLAG_MASK,
    }
}

export function consumeRateLimit(
    attachment: SocketAttachment,
    now: number,
): RateLimitResult
{
    const next = { ...attachment }

    if(now - next.windowStartedAt >= 1000)
    {
        next.windowStartedAt = now
        next.messagesInWindow = 0
    }

    if(next.messagesInWindow >= MAX_CLIENT_MESSAGES_PER_SECOND)
        return { allowed: false, attachment: next }

    next.messagesInWindow++
    return { allowed: true, attachment: next }
}

export function encodeMessage(message: unknown): Uint8Array
{
    return encode(message)
}

export function decodeMessage(message: string | ArrayBuffer): unknown
{
    if(typeof message === 'string')
        return JSON.parse(message) as unknown

    return decode(new Uint8Array(message))
}

export function getMessageSize(message: string | ArrayBuffer): number
{
    return typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength
}
