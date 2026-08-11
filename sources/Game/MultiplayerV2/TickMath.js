export function tickAdd(tick, delta)
{
    return (Number(tick) + Number(delta)) >>> 0
}

export function tickDelta(left, right)
{
    return ((Number(left) >>> 0) - (Number(right) >>> 0)) | 0
}

export function tickAfter(left, right)
{
    return tickDelta(left, right) > 0
}

export function tickAtOrAfter(left, right)
{
    return tickDelta(left, right) >= 0
}
