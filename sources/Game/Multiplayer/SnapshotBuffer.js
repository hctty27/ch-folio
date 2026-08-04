export const MAX_SNAPSHOTS = 20
export const DEFAULT_INTERPOLATION_DELAY_MS = 100

const clamp01 = (value) => Math.min(1, Math.max(0, value))
const lerp = (start, end, alpha) => start + (end - start) * alpha
const cloneSnapshot = (snapshot) => ({
    ...snapshot,
    p: [ ...snapshot.p ],
    q: [ ...snapshot.q ],
})

function interpolateQuaternion(start, end, alpha)
{
    let target = [ ...end ]
    const dot = start.reduce((sum, value, index) => sum + value * target[index], 0)

    if(dot < 0)
        target = target.map((value) => -value)

    const quaternion = start.map((value, index) => lerp(value, target[index], alpha))
    const length = Math.hypot(...quaternion)

    if(length < 1e-8)
        return [ ...start ]

    return quaternion.map((value) => value / length)
}

function interpolateSnapshot(start, end, alpha)
{
    const clampedAlpha = clamp01(alpha)

    return {
        ...end,
        seq: end.seq,
        ts: lerp(start.ts, end.ts, clampedAlpha),
        p: start.p.map((value, index) => lerp(value, end.p[index], clampedAlpha)),
        q: interpolateQuaternion(start.q, end.q, clampedAlpha),
        st: lerp(start.st, end.st, clampedAlpha),
        sp: lerp(start.sp, end.sp, clampedAlpha),
        f: clampedAlpha < 0.5 ? start.f : end.f,
    }
}

export class SnapshotBuffer
{
    constructor({
        maxSnapshots = MAX_SNAPSHOTS,
        interpolationDelayMs = DEFAULT_INTERPOLATION_DELAY_MS,
    } = {})
    {
        this.maxSnapshots = Math.max(2, Math.trunc(maxSnapshots))
        this.interpolationDelayMs = Math.max(0, interpolationDelayMs)
        this.snapshots = []
        this.lastSequence = -1
    }

    get size()
    {
        return this.snapshots.length
    }

    add(snapshot)
    {
        if(!snapshot || !Number.isInteger(snapshot.seq) || snapshot.seq <= this.lastSequence)
            return false

        this.lastSequence = snapshot.seq
        this.snapshots.push(cloneSnapshot(snapshot))

        if(this.snapshots.length > this.maxSnapshots)
            this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots)

        return true
    }

    sample(timestamp)
    {
        if(this.snapshots.length === 0)
            return null

        const renderTimestamp = timestamp - this.interpolationDelayMs
        const first = this.snapshots[0]
        const last = this.snapshots[this.snapshots.length - 1]

        if(this.snapshots.length === 1 || renderTimestamp <= first.ts)
            return cloneSnapshot(first)

        if(renderTimestamp >= last.ts)
            return cloneSnapshot(last)

        for(let index = 1; index < this.snapshots.length; index++)
        {
            const end = this.snapshots[index]
            if(end.ts < renderTimestamp)
                continue

            const start = this.snapshots[index - 1]
            const duration = end.ts - start.ts
            const alpha = duration <= 0 ? 1 : (renderTimestamp - start.ts) / duration
            return interpolateSnapshot(start, end, alpha)
        }

        return cloneSnapshot(last)
    }

    clear()
    {
        this.snapshots.length = 0
        this.lastSequence = -1
    }
}
