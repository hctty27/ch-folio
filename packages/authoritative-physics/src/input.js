const THROTTLE_NEUTRAL = 128
const BRAKE_SAFE = 255
const STEERING_MAX = 32767
const HOLD_TICKS = 6
const RAMP_TICKS = 6

const SUSPENSION_CODES = Object.freeze({
    low: 0,
    mid: 1,
    high: 2,
})

const SUSPENSION_STATES = Object.freeze([ 'low', 'mid', 'high' ])

function clamp(value, minimum, maximum)
{
    if(!Number.isFinite(value))
        return 0

    return Math.min(maximum, Math.max(minimum, value))
}

function toUint32(value)
{
    return Number(value) >>> 0
}

function cloneQuantizedInput(input)
{
    return {
        clientTick: input.clientTick,
        sequence: input.sequence,
        throttle: input.throttle,
        brake: input.brake,
        steering: input.steering,
        suspensions: input.suspensions,
        flags: input.flags,
    }
}

export function packSuspensions(suspensions)
{
    if(!Array.isArray(suspensions) || suspensions.length !== 4)
        throw new TypeError('suspensions must contain exactly four wheel states')

    let packed = 0

    for(let wheelIndex = 0; wheelIndex < suspensions.length; wheelIndex++)
    {
        const code = SUSPENSION_CODES[suspensions[wheelIndex]]
        if(code === undefined)
            throw new TypeError(`invalid suspension state at wheel ${wheelIndex}`)

        packed |= code << (wheelIndex * 2)
    }

    return packed
}

export function unpackSuspensions(packed)
{
    const value = Number(packed) & 0xff
    const suspensions = []

    for(let wheelIndex = 0; wheelIndex < 4; wheelIndex++)
    {
        const code = (value >>> (wheelIndex * 2)) & 0b11
        const state = SUSPENSION_STATES[code]
        if(state === undefined)
            throw new TypeError(`invalid packed suspension state at wheel ${wheelIndex}`)

        suspensions.push(state)
    }

    return suspensions
}

export function quantizeInput(input)
{
    return {
        clientTick: toUint32(input?.clientTick),
        sequence: toUint32(input?.sequence),
        throttle: Math.round((clamp(input?.throttle, -1, 1) + 1) * 127.5),
        brake: Math.round(clamp(input?.brake, 0, 1) * 255),
        steering: Math.round(clamp(input?.steering, -1, 1) * STEERING_MAX),
        suspensions: packSuspensions(input?.suspensions),
        flags: (input?.boosting ? 1 : 0) | (input?.honking ? 2 : 0),
    }
}

export function dequantizeInput(input)
{
    return {
        clientTick: toUint32(input?.clientTick),
        sequence: toUint32(input?.sequence),
        throttle: clamp(input?.throttle, 0, 255) / 127.5 - 1,
        brake: clamp(input?.brake, 0, 255) / 255,
        steering: clamp(input?.steering, -STEERING_MAX, STEERING_MAX) / STEERING_MAX,
        suspensions: unpackSuspensions(input?.suspensions),
        boosting: (Number(input?.flags) & 1) !== 0,
        honking: (Number(input?.flags) & 2) !== 0,
    }
}

export function resolveMissingInput(lastInput, currentTick)
{
    const age = (toUint32(currentTick) - toUint32(lastInput?.clientTick)) >>> 0
    const resolved = cloneQuantizedInput(lastInput)

    if(age <= HOLD_TICKS)
        return resolved

    if(age <= HOLD_TICKS + RAMP_TICKS)
    {
        const progress = age - HOLD_TICKS
        const remaining = RAMP_TICKS - progress

        resolved.throttle = THROTTLE_NEUTRAL
        resolved.steering = Math.round(resolved.steering * remaining / RAMP_TICKS)
        resolved.brake = Math.round(
            resolved.brake + (BRAKE_SAFE - resolved.brake) * progress / RAMP_TICKS,
        )
        return resolved
    }

    return {
        clientTick: resolved.clientTick,
        sequence: resolved.sequence,
        throttle: THROTTLE_NEUTRAL,
        brake: BRAKE_SAFE,
        steering: 0,
        suspensions: 0,
        flags: 0,
    }
}
