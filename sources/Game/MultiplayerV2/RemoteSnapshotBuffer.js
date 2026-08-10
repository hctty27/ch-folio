import {
    tickAfter,
    tickDelta,
} from './TickMath.js'

const DEFAULT_MAX_SNAPSHOTS = 32
const DEFAULT_MAX_EXTRAPOLATION_TICKS = 3
const DEFAULT_SIMULATION_HZ = 60
const INTERPOLATED_SCALARS = Object.freeze([
    'steering',
    'throttle',
    'brake',
    'speed',
    'forwardSpeed',
])

function finiteVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain exactly ${length} finite numbers`)
    return [ ...value ]
}

function normalizeQuaternion(value)
{
    const source = finiteVector(value, 4, 'state.quaternion')
    const length = Math.hypot(...source)
    if(length <= Number.EPSILON)
        throw new TypeError('state.quaternion must not be zero length')
    return source.map((component) => component / length)
}

function cloneWheelContacts(value)
{
    if(!Array.isArray(value))
        return []
    return value.map((contact) => ({
        inContact: contact?.inContact === true,
        contactPoint: Array.isArray(contact?.contactPoint)
            ? [ ...contact.contactPoint ]
            : null,
        suspensionLength: Number.isFinite(contact?.suspensionLength)
            ? Number(contact.suspensionLength)
            : null,
    }))
}

function cloneState(state)
{
    if(!state || !Number.isInteger(state.entityOrder))
        throw new TypeError('state.entityOrder must be an integer')
    const copy = {
        ...state,
        position: finiteVector(state.position, 3, 'state.position'),
        quaternion: normalizeQuaternion(state.quaternion),
        linearVelocity: finiteVector(state.linearVelocity, 3, 'state.linearVelocity'),
        angularVelocity: finiteVector(state.angularVelocity, 3, 'state.angularVelocity'),
        wheelContacts: cloneWheelContacts(state.wheelContacts),
    }
    if(Array.isArray(state.wheelRotations))
        copy.wheelRotations = finiteVector(state.wheelRotations, 4, 'state.wheelRotations')
    return copy
}

function lerp(left, right, amount)
{
    return left + (right - left) * amount
}

function lerpVector(left, right, amount)
{
    return left.map((value, index) => lerp(value, right[index], amount))
}

function quaternionDot(left, right)
{
    return left[0] * right[0]
        + left[1] * right[1]
        + left[2] * right[2]
        + left[3] * right[3]
}

function slerp(leftValue, rightValue, amount)
{
    const left = normalizeQuaternion(leftValue)
    let right = normalizeQuaternion(rightValue)
    let cosine = quaternionDot(left, right)

    if(cosine < 0)
    {
        right = right.map((component) => -component)
        cosine = -cosine
    }

    if(cosine > 0.9995)
        return normalizeQuaternion(lerpVector(left, right, amount))

    const theta = Math.acos(Math.min(1, Math.max(-1, cosine)))
    const sine = Math.sin(theta)
    const leftScale = Math.sin((1 - amount) * theta) / sine
    const rightScale = Math.sin(amount * theta) / sine
    return left.map((component, index) =>
        component * leftScale + right[index] * rightScale)
}

function multiplyQuaternion(left, right)
{
    return normalizeQuaternion([
        left[3] * right[0] + left[0] * right[3] + left[1] * right[2] - left[2] * right[1],
        left[3] * right[1] - left[0] * right[2] + left[1] * right[3] + left[2] * right[0],
        left[3] * right[2] + left[0] * right[1] - left[1] * right[0] + left[2] * right[3],
        left[3] * right[3] - left[0] * right[0] - left[1] * right[1] - left[2] * right[2],
    ])
}

function extrapolateQuaternion(quaternion, angularVelocity, seconds)
{
    const angularSpeed = Math.hypot(...angularVelocity)
    if(angularSpeed <= Number.EPSILON || seconds <= 0)
        return [ ...quaternion ]

    const angle = angularSpeed * seconds
    const halfAngle = angle * 0.5
    const scale = Math.sin(halfAngle) / angularSpeed
    const delta = [
        angularVelocity[0] * scale,
        angularVelocity[1] * scale,
        angularVelocity[2] * scale,
        Math.cos(halfAngle),
    ]
    return multiplyQuaternion(delta, quaternion)
}

function interpolateState(left, right, amount)
{
    const result = cloneState(left)
    result.position = lerpVector(left.position, right.position, amount)
    result.quaternion = slerp(left.quaternion, right.quaternion, amount)
    result.linearVelocity = lerpVector(left.linearVelocity, right.linearVelocity, amount)
    result.angularVelocity = lerpVector(left.angularVelocity, right.angularVelocity, amount)

    if(Array.isArray(left.wheelRotations) && Array.isArray(right.wheelRotations))
        result.wheelRotations = lerpVector(left.wheelRotations, right.wheelRotations, amount)

    for(const field of INTERPOLATED_SCALARS)
    {
        if(Number.isFinite(left[field]) && Number.isFinite(right[field]))
            result[field] = lerp(Number(left[field]), Number(right[field]), amount)
    }
    return result
}

function extrapolateState(state, ticks, simulationHz)
{
    const result = cloneState(state)
    const seconds = ticks / simulationHz
    result.position = result.position.map((value, index) =>
        value + result.linearVelocity[index] * seconds)
    result.quaternion = extrapolateQuaternion(
        result.quaternion,
        result.angularVelocity,
        seconds,
    )
    return result
}

export class RemoteSnapshotBuffer
{
    constructor({
        maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
        maxExtrapolationTicks = DEFAULT_MAX_EXTRAPOLATION_TICKS,
        simulationHz = DEFAULT_SIMULATION_HZ,
    } = {})
    {
        if(!Number.isInteger(maxSnapshots) || maxSnapshots <= 0)
            throw new TypeError('maxSnapshots must be a positive integer')
        if(!Number.isInteger(maxExtrapolationTicks) || maxExtrapolationTicks < 0)
            throw new TypeError('maxExtrapolationTicks must be a non-negative integer')
        if(!Number.isFinite(simulationHz) || simulationHz <= 0)
            throw new TypeError('simulationHz must be positive')

        this.maxSnapshots = maxSnapshots
        this.maxExtrapolationTicks = maxExtrapolationTicks
        this.simulationHz = simulationHz
        this.samples = new Map()
        this.latestTick = null
    }

    get size()
    {
        return this.samples.size
    }

    push(serverTick, state)
    {
        const tick = Number(serverTick) >>> 0
        this.samples.set(tick, cloneState(state))
        if(this.latestTick === null || tickAfter(tick, this.latestTick))
            this.latestTick = tick
        this.#prune()
        return true
    }

    sample(targetTick, fraction = 0)
    {
        if(this.samples.size === 0)
            return null
        const tick = Number(targetTick) >>> 0
        const tickFraction = Number(fraction)
        if(!Number.isFinite(tickFraction) || tickFraction < 0 || tickFraction >= 1)
            throw new TypeError('fraction must be from 0 inclusive to 1 exclusive')

        const ordered = this.#ordered()
        let lower = null
        let upper = null
        let lowerDistance = Number.POSITIVE_INFINITY
        let upperDistance = Number.POSITIVE_INFINITY

        for(const sample of ordered)
        {
            const fromSample = tickDelta(tick, sample.tick)
            if(fromSample >= 0 && fromSample < lowerDistance)
            {
                lower = sample
                lowerDistance = fromSample
            }

            const toSample = tickDelta(sample.tick, tick)
            if(toSample > 0 && toSample < upperDistance)
            {
                upper = sample
                upperDistance = toSample
            }
        }

        if(lower === null)
            return cloneState(upper?.state ?? ordered[0].state)

        if(upper !== null)
        {
            const span = tickDelta(upper.tick, lower.tick)
            const offset = tickDelta(tick, lower.tick) + tickFraction
            const amount = span <= 0 ? 0 : Math.min(1, Math.max(0, offset / span))
            return interpolateState(lower.state, upper.state, amount)
        }

        const aheadTicks = tickDelta(tick, lower.tick) + tickFraction
        if(aheadTicks > 0 && aheadTicks <= this.maxExtrapolationTicks)
            return extrapolateState(lower.state, aheadTicks, this.simulationHz)
        return cloneState(lower.state)
    }

    clear()
    {
        this.samples.clear()
        this.latestTick = null
    }

    #ordered()
    {
        return [ ...this.samples.entries() ]
            .map(([ tick, state ]) => ({ tick, state }))
            .sort((left, right) => tickDelta(left.tick, right.tick))
    }

    #prune()
    {
        const ordered = this.#ordered()
        while(ordered.length > this.maxSnapshots)
        {
            const removed = ordered.shift()
            this.samples.delete(removed.tick)
        }
        if(ordered.length > 0)
            this.latestTick = ordered.at(-1).tick
    }
}
