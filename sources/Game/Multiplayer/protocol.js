export const PROTOCOL_VERSION = 1

export const MESSAGE_TYPES = Object.freeze({
    WELCOME: 'welcome',
    JOINED: 'joined',
    STATE: 'state',
    LEFT: 'left',
    PING: 'ping',
    PONG: 'pong',
    ERROR: 'error',
})

export const STATE_FLAGS = Object.freeze({
    BRAKING: 1,
    BOOSTING: 2,
    HONKING: 4,
    STEERING_LEFT: 8,
    STEERING_RIGHT: 16,
})

const STATE_FLAG_MASK = Object.values(STATE_FLAGS).reduce((mask, flag) => mask | flag, 0)
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function finiteNumber(value, name)
{
    if(!Number.isFinite(value))
        throw new TypeError(`${name} must be finite`)

    return value
}

function finiteTuple(value, length, name)
{
    if(!Array.isArray(value) || value.length !== length)
        throw new TypeError(`${name} must contain ${length} values`)

    return value.map((item, index) => finiteNumber(item, `${name}[${index}]`))
}

function normalizeQuaternion(value)
{
    const quaternion = finiteTuple(value, 4, 'quaternion')
    const length = Math.hypot(...quaternion)

    if(length < 1e-8)
        throw new TypeError('quaternion must have a non-zero length')

    return quaternion.map((component) => component / length)
}

export function createStateMessage({
    sequence,
    timestamp,
    position,
    quaternion,
    steering,
    forwardSpeed,
    flags,
})
{
    const normalizedSequence = Math.max(0, Math.trunc(finiteNumber(sequence, 'sequence')))
    const normalizedTimestamp = Math.max(0, Math.trunc(finiteNumber(timestamp, 'timestamp')))

    return {
        v: PROTOCOL_VERSION,
        t: MESSAGE_TYPES.STATE,
        seq: normalizedSequence,
        ts: normalizedTimestamp,
        p: finiteTuple(position, 3, 'position'),
        q: normalizeQuaternion(quaternion),
        st: clamp(finiteNumber(steering, 'steering'), -1, 1),
        sp: clamp(finiteNumber(forwardSpeed, 'forwardSpeed'), -100, 100),
        f: Math.trunc(finiteNumber(flags, 'flags')) & STATE_FLAG_MASK,
    }
}

export function validateStateMessage(message)
{
    try
    {
        if(!message || message.v !== PROTOCOL_VERSION || message.t !== MESSAGE_TYPES.STATE)
            return false

        const normalized = createStateMessage({
            sequence: message.seq,
            timestamp: message.ts,
            position: message.p,
            quaternion: message.q,
            steering: message.st,
            forwardSpeed: message.sp,
            flags: message.f,
        })

        return normalized.seq === message.seq
            && normalized.ts === message.ts
            && normalized.st === message.st
            && normalized.sp === message.sp
            && normalized.f === message.f
            && normalized.p.every((value, index) => value === message.p[index])
            && normalized.q.every((value, index) => Math.abs(value - message.q[index]) < 1e-6)
    }
    catch
    {
        return false
    }
}
