const MAP_COLLISION_VERSION = 1
const SPAWN_COUNT = 8
const MAX_COLLIDERS = 2048
const MAX_TRIMESH_VERTICES = 200000
const MAX_TRIMESH_INDICES = 600000
const SPAWN_SAFETY_HALF_EXTENTS = Object.freeze([ 2, 1.5, 1.4 ])
const SPAWN_APPROACH_HORIZON_SECONDS = 0.5

function fail(message)
{
    throw new TypeError(`authoritative map: ${message}`)
}

function isPlainObject(value)
{
    if(value === null || typeof value !== 'object' || Array.isArray(value))
        return false

    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function assertFiniteNumber(value, path)
{
    if(!Number.isFinite(value))
        fail(`${path} must contain finite numbers`)
}

function assertFiniteVector(value, length, path, { positive = false } = {})
{
    if(!Array.isArray(value) || value.length !== length)
        fail(`${path} must contain exactly ${length} numbers`)

    for(let index = 0; index < value.length; index++)
    {
        assertFiniteNumber(value[index], `${path}[${index}]`)
        if(positive && value[index] <= 0)
            fail(`${path}[${index}] must be positive`)
    }
}

function assertUnitQuaternion(value, path)
{
    assertFiniteVector(value, 4, path)

    const length = Math.hypot(...value)
    if(Math.abs(length - 1) > 1e-5)
        fail(`${path} must be a normalized quaternion`)
}

function assertMaterial(collider, path)
{
    assertFiniteNumber(collider.friction, `${path}.friction`)
    assertFiniteNumber(collider.restitution, `${path}.restitution`)

    if(collider.friction < 0 || collider.restitution < 0)
        fail(`${path} material values must be non-negative`)
}

function validateCuboid(collider, path)
{
    assertFiniteVector(collider.center, 3, `${path}.center`)
    assertFiniteVector(collider.halfExtents, 3, `${path}.halfExtents`, { positive: true })
    assertUnitQuaternion(collider.quaternion, `${path}.quaternion`)
}

function validateTrimesh(collider, path)
{
    if(!Array.isArray(collider.vertices) || collider.vertices.length < 9 || collider.vertices.length % 3 !== 0)
        fail(`${path}.vertices must contain complete triangle-mesh vertices`)

    const vertexCount = collider.vertices.length / 3
    if(vertexCount > MAX_TRIMESH_VERTICES)
        fail(`${path} has excessive vertex count`)

    collider.vertices.forEach((value, index) => assertFiniteNumber(value, `${path}.vertices[${index}]`))

    if(!Array.isArray(collider.indices) || collider.indices.length < 3 || collider.indices.length % 3 !== 0)
        fail(`${path}.indices must contain complete triangles`)

    if(collider.indices.length > MAX_TRIMESH_INDICES)
        fail(`${path} has excessive index count`)

    for(let index = 0; index < collider.indices.length; index++)
    {
        const vertexIndex = collider.indices[index]
        if(!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertexCount)
            fail(`${path}.indices[${index}] is outside the vertex buffer`)
    }
}

function validateColliders(colliders)
{
    if(!Array.isArray(colliders) || colliders.length === 0)
        fail('colliders must be a non-empty array')

    if(colliders.length > MAX_COLLIDERS)
        fail('colliders has excessive count')

    let previousId = null

    for(let index = 0; index < colliders.length; index++)
    {
        const collider = colliders[index]
        const path = `colliders[${index}]`

        if(!isPlainObject(collider))
            fail(`${path} must be an object`)

        if(typeof collider.id !== 'string' || collider.id.length === 0 || collider.id.length > 512)
            fail(`${path}.id must be a bounded non-empty string`)

        if(previousId !== null && collider.id <= previousId)
            fail('colliders must have sorted collider IDs with no duplicates')
        previousId = collider.id

        assertMaterial(collider, path)

        if(collider.shape === 'cuboid')
            validateCuboid(collider, path)
        else if(collider.shape === 'trimesh')
            validateTrimesh(collider, path)
        else
            fail(`${path} has unknown collider shape ${String(collider.shape)}`)
    }
}

function validateSpawns(spawns)
{
    if(!Array.isArray(spawns) || spawns.length !== SPAWN_COUNT)
        fail('map must contain exactly eight spawn points')

    let previousSource = null

    for(let index = 0; index < spawns.length; index++)
    {
        const spawn = spawns[index]
        const path = `spawns[${index}]`

        if(!isPlainObject(spawn))
            fail(`${path} must be an object`)

        if(spawn.index !== index)
            fail(`${path}.index must match deterministic spawn order`)

        if(typeof spawn.source !== 'string' || spawn.source.length === 0 || spawn.source.length > 1024)
            fail(`${path}.source must be a bounded non-empty string`)

        if(previousSource !== null && spawn.source <= previousSource)
            fail('spawns must use strictly sorted source paths')
        previousSource = spawn.source

        assertFiniteVector(spawn.position, 3, `${path}.position`)
        assertUnitQuaternion(spawn.quaternion, `${path}.quaternion`)
        assertFiniteVector(spawn.safetyHalfExtents, 3, `${path}.safetyHalfExtents`, { positive: true })

        if(!spawn.safetyHalfExtents.every((value, axis) => value === SPAWN_SAFETY_HALF_EXTENTS[axis]))
            fail(`${path}.safetyHalfExtents must match the authoritative safety volume`)

        assertFiniteNumber(spawn.approachHorizonSeconds, `${path}.approachHorizonSeconds`)
        if(spawn.approachHorizonSeconds !== SPAWN_APPROACH_HORIZON_SECONDS)
            fail(`${path}.approachHorizonSeconds must match the authoritative horizon`)
    }
}

function cloneValue(value)
{
    if(Array.isArray(value))
        return value.map(cloneValue)

    if(isPlainObject(value))
    {
        const clone = {}
        for(const [ key, child ] of Object.entries(value))
            clone[key] = cloneValue(child)
        return clone
    }

    return value
}

function deepFreeze(value)
{
    if(value === null || typeof value !== 'object' || Object.isFrozen(value))
        return value

    for(const child of Object.values(value))
        deepFreeze(child)

    return Object.freeze(value)
}

export function loadAuthoritativeMap(data)
{
    if(!isPlainObject(data))
        fail('root must be an object')

    if(data.mapCollisionVersion !== MAP_COLLISION_VERSION)
        fail(`mapCollisionVersion must equal ${MAP_COLLISION_VERSION}`)

    validateColliders(data.colliders)
    validateSpawns(data.spawns)

    return deepFreeze(cloneValue(data))
}

export {
    MAP_COLLISION_VERSION,
    MAX_COLLIDERS,
    MAX_TRIMESH_INDICES,
    MAX_TRIMESH_VERTICES,
    SPAWN_APPROACH_HORIZON_SECONDS,
    SPAWN_COUNT,
    SPAWN_SAFETY_HALF_EXTENTS,
}
