const DEFAULT_DURATION_SECONDS = 0.1
const DEFAULT_SNAP_DISTANCE = 3
const DEFAULT_SNAP_ANGLE = Math.PI * 0.5

function finiteVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain exactly ${length} finite numbers`)
    return value
}

function normalizeQuaternion(value)
{
    const source = finiteVector(value, 4, 'quaternion')
    const length = Math.hypot(...source)
    if(length === 0)
        throw new TypeError('quaternion must not be zero length')
    return source.map((component) => component / length)
}

function quaternionDot(left, right)
{
    return left[0] * right[0]
        + left[1] * right[1]
        + left[2] * right[2]
        + left[3] * right[3]
}

function quaternionAngle(left, right)
{
    return 2 * Math.acos(Math.min(1, Math.abs(quaternionDot(left, right))))
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
    {
        const result = left.map((component, index) =>
            component + (right[index] - component) * amount)
        return normalizeQuaternion(result)
    }

    const theta = Math.acos(Math.min(1, Math.max(-1, cosine)))
    const sine = Math.sin(theta)
    const leftScale = Math.sin((1 - amount) * theta) / sine
    const rightScale = Math.sin(amount * theta) / sine
    return left.map((component, index) =>
        component * leftScale + right[index] * rightScale)
}

function distance(left, right)
{
    return Math.hypot(
        left[0] - right[0],
        left[1] - right[1],
        left[2] - right[2],
    )
}

export class VisualCorrection
{
    constructor({
        durationSeconds = DEFAULT_DURATION_SECONDS,
        snapDistance = DEFAULT_SNAP_DISTANCE,
        snapAngle = DEFAULT_SNAP_ANGLE,
    } = {})
    {
        if(!Number.isFinite(durationSeconds) || durationSeconds <= 0)
            throw new TypeError('durationSeconds must be positive')
        if(!Number.isFinite(snapDistance) || snapDistance < 0)
            throw new TypeError('snapDistance must be non-negative')
        if(!Number.isFinite(snapAngle) || snapAngle < 0)
            throw new TypeError('snapAngle must be non-negative')

        this.durationSeconds = durationSeconds
        this.snapDistance = snapDistance
        this.snapAngle = snapAngle
        this.corrections = new Map()
    }

    capture(beforeStates, afterStates, { hard = false } = {})
    {
        if(!Array.isArray(beforeStates) || !Array.isArray(afterStates))
            throw new TypeError('beforeStates and afterStates must be arrays')

        this.corrections.clear()
        if(hard)
            return 0

        const beforeByEntity = new Map(beforeStates.map((state) => [ state.entityOrder, state ]))
        for(const after of afterStates)
        {
            const before = beforeByEntity.get(after.entityOrder)
            if(!before)
                continue

            const beforePosition = [ ...finiteVector(before.position, 3, 'before.position') ]
            const afterPosition = finiteVector(after.position, 3, 'after.position')
            const beforeQuaternion = normalizeQuaternion(before.quaternion)
            const afterQuaternion = normalizeQuaternion(after.quaternion)

            if(
                distance(beforePosition, afterPosition) >= this.snapDistance
                || quaternionAngle(beforeQuaternion, afterQuaternion) >= this.snapAngle
            )
                continue

            this.corrections.set(after.entityOrder, {
                elapsed: 0,
                positionOffset: beforePosition.map((component, index) =>
                    component - afterPosition[index]),
                fromQuaternion: beforeQuaternion,
            })
        }

        return this.corrections.size
    }

    advance(deltaSeconds)
    {
        if(!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
            throw new TypeError('deltaSeconds must be non-negative')

        for(const [ entityOrder, correction ] of this.corrections)
        {
            correction.elapsed = Math.min(
                this.durationSeconds,
                correction.elapsed + deltaSeconds,
            )
            if(correction.elapsed >= this.durationSeconds)
                this.corrections.delete(entityOrder)
        }
    }

    apply(state)
    {
        const correction = this.corrections.get(state?.entityOrder)
        if(!correction)
            return state

        const position = finiteVector(state.position, 3, 'state.position')
        const quaternion = normalizeQuaternion(state.quaternion)
        const remaining = 1 - correction.elapsed / this.durationSeconds

        return {
            ...state,
            position: position.map((component, index) =>
                component + correction.positionOffset[index] * remaining),
            quaternion: slerp(quaternion, correction.fromQuaternion, remaining),
        }
    }

    clear()
    {
        this.corrections.clear()
    }
}
