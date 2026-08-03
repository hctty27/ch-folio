import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { materializeVehicle } from './materialize-vehicle.js'

async function createDirectories() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'su7-materialize-'))
    const chunksDirectory = path.join(root, 'chunks')
    const outputDirectory = path.join(root, 'vehicle')
    await mkdir(chunksDirectory, { recursive: true })
    return { chunksDirectory, outputDirectory }
}

test('materializeVehicle joins ordered chunks and writes both GLB targets', async () => {
    const { chunksDirectory, outputDirectory } = await createDirectories()
    const expected = Buffer.from('glTF-test-payload')
    const expectedSha256 = createHash('sha256').update(expected).digest('hex')
    const encoded = gzipSync(expected).toString('base64')

    await writeFile(path.join(chunksDirectory, 'part-002.txt'), encoded.slice(8))
    await writeFile(path.join(chunksDirectory, 'part-001.txt'), encoded.slice(0, 8))

    await materializeVehicle({
        chunksDirectory,
        outputDirectory,
        expectedChunkCount: 2,
        expectedGlbSha256: expectedSha256,
    })

    assert.deepEqual(await readFile(path.join(outputDirectory, 'default.glb')), expected)
    assert.deepEqual(await readFile(path.join(outputDirectory, 'default-compressed.glb')), expected)
})

test('materializeVehicle rejects an incomplete chunk sequence before decompression', async () => {
    const { chunksDirectory, outputDirectory } = await createDirectories()
    await writeFile(path.join(chunksDirectory, 'part-001.txt'), 'H4sI')

    await assert.rejects(
        materializeVehicle({
            chunksDirectory,
            outputDirectory,
            expectedChunkCount: 2,
            expectedGlbSha256: null,
        }),
        /Incomplete vehicle chunks/,
    )
})
