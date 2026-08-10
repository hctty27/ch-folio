import { NodeIO } from '@gltf-transform/core'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    MAP_COLLISION_VERSION,
    SPAWN_APPROACH_HORIZON_SECONDS,
    SPAWN_COUNT,
    SPAWN_SAFETY_HALF_EXTENTS,
    loadAuthoritativeMap,
} from '../packages/authoritative-physics/src/map.js'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const physicalMapPath = resolve(repositoryRoot, 'static/playground/playgroundPhysical.glb')
const respawnPath = resolve(repositoryRoot, 'static/respawns/respawnsReferences.glb')
const defaultOutputPath = resolve(repositoryRoot, 'packages/authoritative-physics/generated/map-v1.json')
const TRIANGLES_MODE = 4
const ROUNDING_FACTOR = 1_000_000
const COLLIDER_FRICTION = 0.25
const COLLIDER_RESTITUTION = 0

function compareCodeUnits(left, right)
{
    if(left < right)
        return -1
    if(left > right)
        return 1
    return 0
}

function roundNumber(value)
{
    if(!Number.isFinite(value))
        throw new TypeError('authoritative map export encountered a non-finite number')

    const rounded = Math.round(value * ROUNDING_FACTOR) / ROUNDING_FACTOR
    return Object.is(rounded, -0) ? 0 : rounded
}

function roundArray(values)
{
    return Array.from(values, roundNumber)
}

function padded(value, width = 4)
{
    return String(value).padStart(width, '0')
}

function encodeName(value, fallback)
{
    return encodeURIComponent(value || fallback)
}

function listNodeRecords(document)
{
    const records = []
    const scenes = document.getRoot().listScenes()

    function visit(node, parentPath, siblingIndex)
    {
        const segment = `${padded(siblingIndex)}:${encodeName(node.getName(), 'node')}`
        const path = `${parentPath}/${segment}`
        records.push({ node, path })

        node.listChildren().forEach((child, index) => visit(child, path, index))
    }

    scenes.forEach((scene, sceneIndex) =>
    {
        const scenePath = `${padded(sceneIndex)}:${encodeName(scene.getName(), 'scene')}`
        scene.listChildren().forEach((node, index) => visit(node, scenePath, index))
    })

    return records.sort((left, right) => compareCodeUnits(left.path, right.path))
}

function transformPoint(matrix, x, y, z)
{
    return [
        roundNumber(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]),
        roundNumber(matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]),
        roundNumber(matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]),
    ]
}

function determinant3(matrix)
{
    const a00 = matrix[0]
    const a01 = matrix[4]
    const a02 = matrix[8]
    const a10 = matrix[1]
    const a11 = matrix[5]
    const a12 = matrix[9]
    const a20 = matrix[2]
    const a21 = matrix[6]
    const a22 = matrix[10]

    return a00 * (a11 * a22 - a12 * a21)
        - a01 * (a10 * a22 - a12 * a20)
        + a02 * (a10 * a21 - a11 * a20)
}

function quaternionFromRotationMatrix(r00, r01, r02, r10, r11, r12, r20, r21, r22)
{
    const trace = r00 + r11 + r22
    let x
    let y
    let z
    let w

    if(trace > 0)
    {
        const scale = Math.sqrt(trace + 1) * 2
        w = 0.25 * scale
        x = (r21 - r12) / scale
        y = (r02 - r20) / scale
        z = (r10 - r01) / scale
    }
    else if(r00 > r11 && r00 > r22)
    {
        const scale = Math.sqrt(1 + r00 - r11 - r22) * 2
        w = (r21 - r12) / scale
        x = 0.25 * scale
        y = (r01 + r10) / scale
        z = (r02 + r20) / scale
    }
    else if(r11 > r22)
    {
        const scale = Math.sqrt(1 + r11 - r00 - r22) * 2
        w = (r02 - r20) / scale
        x = (r01 + r10) / scale
        y = 0.25 * scale
        z = (r12 + r21) / scale
    }
    else
    {
        const scale = Math.sqrt(1 + r22 - r00 - r11) * 2
        w = (r10 - r01) / scale
        x = (r02 + r20) / scale
        y = (r12 + r21) / scale
        z = 0.25 * scale
    }

    const length = Math.hypot(x, y, z, w)
    if(!Number.isFinite(length) || length === 0)
        throw new TypeError('authoritative map export encountered an invalid transform quaternion')

    const sign = w < 0 ? -1 : 1
    return roundArray([ x / length * sign, y / length * sign, z / length * sign, w / length * sign ])
}

function decomposeMatrix(matrix)
{
    let scaleX = Math.hypot(matrix[0], matrix[1], matrix[2])
    const scaleY = Math.hypot(matrix[4], matrix[5], matrix[6])
    const scaleZ = Math.hypot(matrix[8], matrix[9], matrix[10])

    if(scaleX === 0 || scaleY === 0 || scaleZ === 0)
        throw new TypeError('authoritative map export encountered a zero-scale transform')

    if(determinant3(matrix) < 0)
        scaleX = -scaleX

    const rotation = quaternionFromRotationMatrix(
        matrix[0] / scaleX,
        matrix[4] / scaleY,
        matrix[8] / scaleZ,
        matrix[1] / scaleX,
        matrix[5] / scaleY,
        matrix[9] / scaleZ,
        matrix[2] / scaleX,
        matrix[6] / scaleY,
        matrix[10] / scaleZ,
    )

    return {
        position: roundArray([ matrix[12], matrix[13], matrix[14] ]),
        quaternion: rotation,
        scale: roundArray([ scaleX, scaleY, scaleZ ]),
    }
}

function getPositionArray(primitive, source)
{
    const accessor = primitive.getAttribute('POSITION')
    if(!accessor)
        throw new TypeError(`${source} is missing POSITION data`)

    const values = accessor.getArray()
    if(!values || accessor.getElementSize() !== 3 || values.length < 9 || values.length % 3 !== 0)
        throw new TypeError(`${source} has invalid POSITION data`)

    return Array.from(values)
}

function getIndexArray(primitive, vertexCount, source)
{
    const accessor = primitive.getIndices()
    const indices = accessor
        ? Array.from(accessor.getArray() || [])
        : Array.from({ length: vertexCount }, (_, index) => index)

    if(indices.length < 3 || indices.length % 3 !== 0)
        throw new TypeError(`${source} has incomplete triangle indices`)

    for(const index of indices)
    {
        if(!Number.isInteger(index) || index < 0 || index >= vertexCount)
            throw new TypeError(`${source} contains an invalid vertex index`)
    }

    return indices
}

function inspectLocalCuboid(positions, indices)
{
    if(indices.length !== 36)
        return null

    const points = []
    for(let offset = 0; offset < positions.length; offset += 3)
        points.push(roundArray(positions.slice(offset, offset + 3)))

    const unique = new Map(points.map((point) => [ point.join(','), point ]))
    if(unique.size !== 8)
        return null

    const values = [ ...unique.values() ]
    const minimum = [ 0, 1, 2 ].map((axis) => Math.min(...values.map((point) => point[axis])))
    const maximum = [ 0, 1, 2 ].map((axis) => Math.max(...values.map((point) => point[axis])))

    if(minimum.some((value, axis) => value === maximum[axis]))
        return null

    const expected = new Set()
    for(const x of [ minimum[0], maximum[0] ])
    {
        for(const y of [ minimum[1], maximum[1] ])
        {
            for(const z of [ minimum[2], maximum[2] ])
                expected.add([ x, y, z ].join(','))
        }
    }

    if([ ...unique.keys() ].some((key) => !expected.has(key)))
        return null

    return {
        center: minimum.map((value, axis) => roundNumber((value + maximum[axis]) * 0.5)),
        halfExtents: minimum.map((value, axis) => roundNumber((maximum[axis] - value) * 0.5)),
    }
}

function createCuboidCollider(localCuboid, matrix)
{
    const transform = decomposeMatrix(matrix)

    return {
        shape: 'cuboid',
        center: transformPoint(matrix, ...localCuboid.center),
        halfExtents: localCuboid.halfExtents.map((value, axis) => roundNumber(Math.abs(value * transform.scale[axis]))),
        quaternion: transform.quaternion,
        friction: COLLIDER_FRICTION,
        restitution: COLLIDER_RESTITUTION,
    }
}

function createTrimeshCollider(positions, indices, matrix)
{
    const vertices = []
    for(let offset = 0; offset < positions.length; offset += 3)
        vertices.push(...transformPoint(matrix, positions[offset], positions[offset + 1], positions[offset + 2]))

    return {
        shape: 'trimesh',
        vertices,
        indices,
        friction: COLLIDER_FRICTION,
        restitution: COLLIDER_RESTITUTION,
    }
}

function extractColliders(document)
{
    const records = []

    for(const { node, path } of listNodeRecords(document))
    {
        const mesh = node.getMesh()
        if(!mesh)
            continue

        const matrix = node.getWorldMatrix()
        mesh.listPrimitives().forEach((primitive, primitiveIndex) =>
        {
            const source = `${path}/primitive:${padded(primitiveIndex)}`
            if(primitive.getMode() !== TRIANGLES_MODE)
                throw new TypeError(`${source} must use TRIANGLES mode`)

            const positions = getPositionArray(primitive, source)
            const indices = getIndexArray(primitive, positions.length / 3, source)
            const localCuboid = inspectLocalCuboid(positions, indices)
            const collider = localCuboid
                ? createCuboidCollider(localCuboid, matrix)
                : createTrimeshCollider(positions, indices, matrix)

            records.push({ source, collider })
        })
    }

    records.sort((left, right) => compareCodeUnits(left.source, right.source))

    return [
        {
            id: '000000:floor',
            shape: 'cuboid',
            center: [ 0, -1.01, 0 ],
            halfExtents: [ 1000, 1, 1000 ],
            quaternion: [ 0, 0, 0, 1 ],
            friction: COLLIDER_FRICTION,
            restitution: COLLIDER_RESTITUTION,
        },
        ...records.map(({ source, collider }, index) => ({
            id: `${padded(index + 1, 6)}:${source}`,
            ...collider,
        })),
    ]
}

function extractSpawns(document)
{
    const candidates = []

    for(const { node, path } of listNodeRecords(document))
    {
        try
        {
            const transform = decomposeMatrix(node.getWorldMatrix())
            candidates.push({
                source: path,
                position: transform.position,
                quaternion: transform.quaternion,
            })
        }
        catch
        {
            // Invalid transforms are excluded deterministically and the count check below remains authoritative.
        }
    }

    candidates.sort((left, right) => compareCodeUnits(left.source, right.source))

    if(candidates.length < SPAWN_COUNT)
        throw new TypeError(`respawn GLB contains ${candidates.length} finite transforms; ${SPAWN_COUNT} are required`)

    return candidates.slice(0, SPAWN_COUNT).map((candidate, index) => ({
        index,
        source: candidate.source,
        position: candidate.position,
        quaternion: candidate.quaternion,
        safetyHalfExtents: [ ...SPAWN_SAFETY_HALF_EXTENTS ],
        approachHorizonSeconds: SPAWN_APPROACH_HORIZON_SECONDS,
    }))
}

function parseOutputPath(argumentsList)
{
    if(argumentsList.length === 0)
        return defaultOutputPath

    if(argumentsList.length === 2 && argumentsList[0] === '--output' && argumentsList[1])
        return resolve(process.cwd(), argumentsList[1])

    throw new TypeError('usage: node scripts/export-authoritative-map.mjs [--output path]')
}

async function main()
{
    const outputPath = parseOutputPath(process.argv.slice(2))
    const io = new NodeIO()
    const [ physicalDocument, respawnDocument ] = await Promise.all([
        io.read(physicalMapPath),
        io.read(respawnPath),
    ])

    const map = loadAuthoritativeMap({
        mapCollisionVersion: MAP_COLLISION_VERSION,
        colliders: extractColliders(physicalDocument),
        spawns: extractSpawns(respawnDocument),
    })
    const output = `${JSON.stringify(map, null, 2)}\n`

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, output, 'utf8')

    console.log('[authoritative-map]', {
        output: outputPath,
        bytes: Buffer.byteLength(output),
        colliders: map.colliders.length,
        spawns: map.spawns.length,
        mapCollisionVersion: map.mapCollisionVersion,
    })
}

await main()
