function vector3(value)
{
    return { x: value[0], y: value[1], z: value[2] }
}

function quaternion(value)
{
    return { x: value[0], y: value[1], z: value[2], w: value[3] }
}

function assertVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain exactly ${length} finite numbers`)
}

function createBounds(position, halfExtents)
{
    return {
        minimum: position.map((value, axis) => value - halfExtents[axis]),
        maximum: position.map((value, axis) => value + halfExtents[axis]),
    }
}

function createSweptBounds(state, halfExtents, horizonSeconds)
{
    assertVector(state?.position, 3, 'vehicle position')
    assertVector(state?.linearVelocity, 3, 'vehicle linearVelocity')

    const end = state.position.map((value, axis) =>
        value + state.linearVelocity[axis] * horizonSeconds)

    return {
        minimum: state.position.map((value, axis) =>
            Math.min(value, end[axis]) - halfExtents[axis]),
        maximum: state.position.map((value, axis) =>
            Math.max(value, end[axis]) + halfExtents[axis]),
    }
}

function boundsIntersect(left, right)
{
    for(let axis = 0; axis < 3; axis++)
    {
        if(left.maximum[axis] < right.minimum[axis] || right.maximum[axis] < left.minimum[axis])
            return false
    }

    return true
}

function intersectsDynamicCollider({ RAPIER, world, spawn })
{
    if(!RAPIER?.Cuboid || typeof world?.intersectionsWithShape !== 'function')
        throw new TypeError('safe spawn queries require Rapier intersectionsWithShape support')

    const shape = new RAPIER.Cuboid(...spawn.safetyHalfExtents)
    const filterFlags = RAPIER.QueryFilterFlags?.EXCLUDE_FIXED
    let intersects = false

    world.intersectionsWithShape(
        vector3(spawn.position),
        quaternion(spawn.quaternion),
        shape,
        () =>
        {
            intersects = true
            return false
        },
        filterFlags,
    )

    return intersects
}

export function isSpawnSafe({
    RAPIER,
    world,
    spawn,
    vehicleStates = [],
})
{
    if(!spawn || !Number.isInteger(spawn.index))
        throw new TypeError('spawn must be an authoritative spawn descriptor')

    assertVector(spawn.position, 3, 'spawn position')
    assertVector(spawn.quaternion, 4, 'spawn quaternion')
    assertVector(spawn.safetyHalfExtents, 3, 'spawn safetyHalfExtents')

    if(intersectsDynamicCollider({ RAPIER, world, spawn }))
        return false

    const spawnBounds = createBounds(spawn.position, spawn.safetyHalfExtents)
    for(const state of vehicleStates)
    {
        const sweptBounds = createSweptBounds(
            state,
            spawn.safetyHalfExtents,
            spawn.approachHorizonSeconds,
        )
        if(boundsIntersect(spawnBounds, sweptBounds))
            return false
    }

    return true
}

export function findSafeSpawn({
    RAPIER,
    world,
    spawns,
    vehicleStates = [],
})
{
    if(!Array.isArray(spawns))
        throw new TypeError('spawns must be an array')

    const orderedSpawns = [ ...spawns ]
        .sort((left, right) => left.index - right.index)

    for(const spawn of orderedSpawns)
    {
        if(isSpawnSafe({ RAPIER, world, spawn, vehicleStates }))
            return spawn
    }

    return null
}
