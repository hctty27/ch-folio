import { gunzipSync } from 'node:zlib'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function materializeVehicle({ chunksDirectory, outputDirectory }) {
    const chunkNames = (await readdir(chunksDirectory))
        .filter((name) => /^part-\d+\.txt$/.test(name))
        .sort()

    if (chunkNames.length === 0)
        throw new Error(`No vehicle chunks found in ${chunksDirectory}`)

    const encodedParts = await Promise.all(
        chunkNames.map(async (name) => (await readFile(path.join(chunksDirectory, name), 'utf8')).trim())
    )
    const glb = gunzipSync(Buffer.from(encodedParts.join(''), 'base64'))

    if (glb.length < 12 || glb.subarray(0, 4).toString('ascii') !== 'glTF')
        throw new Error('Materialized vehicle is not a valid GLB file')

    await mkdir(outputDirectory, { recursive: true })
    await Promise.all([
        writeFile(path.join(outputDirectory, 'default.glb'), glb),
        writeFile(path.join(outputDirectory, 'default-compressed.glb'), glb),
    ])
}

const isExecutedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isExecutedDirectly) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    await materializeVehicle({
        chunksDirectory: path.join(repositoryRoot, 'static', 'vehicle', 'su7-base64'),
        outputDirectory: path.join(repositoryRoot, 'static', 'vehicle'),
    })
}
