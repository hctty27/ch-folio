import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { materializeVehicle } from './materialize-vehicle.js'

test('materializeVehicle joins ordered base64 chunks and writes both GLB targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'su7-materialize-'))
    const chunksDirectory = path.join(root, 'chunks')
    const outputDirectory = path.join(root, 'vehicle')
    await mkdir(chunksDirectory, { recursive: true })

    const expected = Buffer.from('glTF-test-payload')
    const encoded = gzipSync(expected).toString('base64')
    await writeFile(path.join(chunksDirectory, 'part-002.txt'), encoded.slice(8))
    await writeFile(path.join(chunksDirectory, 'part-001.txt'), encoded.slice(0, 8))

    await materializeVehicle({ chunksDirectory, outputDirectory })

    assert.deepEqual(await readFile(path.join(outputDirectory, 'default.glb')), expected)
    assert.deepEqual(await readFile(path.join(outputDirectory, 'default-compressed.glb')), expected)
})
