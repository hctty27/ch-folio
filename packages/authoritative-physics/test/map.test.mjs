import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { loadAuthoritativeMap } from '../src/index.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const exporterPath = fileURLToPath(new URL('../../../scripts/export-authoritative-map.mjs', import.meta.url))
const committedMapPath = fileURLToPath(new URL('../generated/map-v1.json', import.meta.url))
const MAX_MAP_BYTES = 512 * 1024

function assertFiniteNumbers(value, path = 'map')
{
    if(typeof value === 'number')
    {
        assert.ok(Number.isFinite(value), `${path} must be finite`)
        return
    }

    if(Array.isArray(value))
    {
        value.forEach((child, index) => assertFiniteNumbers(child, `${path}[${index}]`))
        return
    }

    if(value && typeof value === 'object')
    {
        for(const [ key, child ] of Object.entries(value))
            assertFiniteNumbers(child, `${path}.${key}`)
    }
}

async function exportMap(outputPath)
{
    await execFileAsync(process.execPath, [ exporterPath, '--output', outputPath ], {
        cwd: repositoryRoot,
        maxBuffer: 4 * 1024 * 1024,
    })

    return readFile(outputPath)
}

test('authoritative map export is byte-identical, versioned, bounded, and contains eight deterministic spawns', async () =>
{
    const directory = await mkdtemp(join(tmpdir(), 'ch-folio-map-'))

    try
    {
        const first = await exportMap(join(directory, 'first.json'))
        const second = await exportMap(join(directory, 'second.json'))
        const committed = await readFile(committedMapPath)

        assert.deepEqual(second, first)
        assert.deepEqual(committed, first)
        assert.ok(first.byteLength <= MAX_MAP_BYTES, `map is ${first.byteLength} bytes`)

        const parsed = JSON.parse(first.toString('utf8'))
        const map = loadAuthoritativeMap(parsed)

        assert.equal(map.mapCollisionVersion, 1)
        assert.equal(map.spawns.length, 8)

        const colliderIds = map.colliders.map((collider) => collider.id)
        assert.deepEqual(colliderIds, [ ...colliderIds ].sort())
        assert.equal(new Set(colliderIds).size, colliderIds.length)

        assert.deepEqual(map.colliders[0], {
            id: '000000:floor',
            shape: 'cuboid',
            center: [ 0, -1.01, 0 ],
            halfExtents: [ 1000, 1, 1000 ],
            quaternion: [ 0, 0, 0, 1 ],
            friction: 0.25,
            restitution: 0,
        })

        assert.deepEqual(map.spawns.map((spawn) => spawn.index), [ 0, 1, 2, 3, 4, 5, 6, 7 ])
        for(const spawn of map.spawns)
        {
            assert.deepEqual(spawn.safetyHalfExtents, [ 2, 1.5, 1.4 ])
            assert.equal(spawn.approachHorizonSeconds, 0.5)
        }

        assertFiniteNumbers(map)
    }
    finally
    {
        await rm(directory, { recursive: true, force: true })
    }
})

test('authoritative map loader rejects incompatible, unordered, malformed, or non-eight-spawn data', () =>
{
    const spawn = {
        index: 0,
        source: '0000:spawn',
        position: [ 0, 1, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
        safetyHalfExtents: [ 2, 1.5, 1.4 ],
        approachHorizonSeconds: 0.5,
    }
    const floor = {
        id: '000000:floor',
        shape: 'cuboid',
        center: [ 0, -1.01, 0 ],
        halfExtents: [ 1000, 1, 1000 ],
        quaternion: [ 0, 0, 0, 1 ],
        friction: 0.25,
        restitution: 0,
    }
    const valid = {
        mapCollisionVersion: 1,
        colliders: [ floor ],
        spawns: Array.from({ length: 8 }, (_, index) => ({
            ...spawn,
            index,
            source: `${String(index).padStart(4, '0')}:spawn`,
        })),
    }

    assert.doesNotThrow(() => loadAuthoritativeMap(valid))
    assert.throws(
        () => loadAuthoritativeMap({ ...valid, mapCollisionVersion: 2 }),
        /mapCollisionVersion/,
    )
    assert.throws(
        () => loadAuthoritativeMap({ ...valid, spawns: valid.spawns.slice(0, 7) }),
        /eight spawn/i,
    )
    assert.throws(
        () => loadAuthoritativeMap({
            ...valid,
            colliders: [
                { ...floor, id: '000002:z' },
                { ...floor, id: '000001:a' },
            ],
        }),
        /sorted collider IDs/i,
    )
    assert.throws(
        () => loadAuthoritativeMap({
            ...valid,
            colliders: [ { ...floor, shape: 'sphere' } ],
        }),
        /unknown collider shape/i,
    )
    assert.throws(
        () => loadAuthoritativeMap({
            ...valid,
            colliders: [ { ...floor, center: [ Number.NaN, 0, 0 ] } ],
        }),
        /finite/i,
    )
})
