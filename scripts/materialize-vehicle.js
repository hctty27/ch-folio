import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const DEFAULT_CHUNK_COUNT = 19
const DEFAULT_GLB_SHA256 = 'f811dd420e6860c477dfe436ae5a2ddd6e100a7ee83e258a59b8b21163d1b375'

function expectedChunkNames(count) {
    return Array.from(
        { length: count },
        (_, index) => `part-${String(index + 1).padStart(3, '0')}.txt`,
    )
}

export async function materializeVehicle({
    chunksDirectory,
    outputDirectory,
    expectedChunkCount = DEFAULT_CHUNK_COUNT,
    expectedGlbSha256 = DEFAULT_GLB_SHA256,
}) {
    const chunkNames = (await readdir(chunksDirectory))
        .filter((name) => /^part-\d+\.txt$/.test(name))
        .sort()

    const requiredNames = expectedChunkNames(expectedChunkCount)
    if (chunkNames.length !== requiredNames.length || chunkNames.some((name, index) => name !== requiredNames[index])) {
        throw new Error(
            `Incomplete vehicle chunks: expected ${requiredNames.join(', ')}, found ${chunkNames.join(', ') || 'none'}`,
        )
    }

    const encodedParts = await Promise.all(
        chunkNames.map(async (name) => (await readFile(path.join(chunksDirectory, name), 'utf8')).trim()),
    )
    const gzip = Buffer.from(encodedParts.join(''), 'base64')

    if (gzip.length < 2 || gzip[0] !== 0x1f || gzip[1] !== 0x8b)
        throw new Error('Vehicle chunks do not decode to a gzip stream')

    let glb
    try {
        glb = gunzipSync(gzip)
    }
    catch (error) {
        throw new Error(`Unable to decompress vehicle asset: ${error.message}`, { cause: error })
    }

    if (glb.length < 12 || glb.subarray(0, 4).toString('ascii') !== 'glTF')
        throw new Error('Materialized vehicle is not a valid GLB file')

    const actualSha256 = createHash('sha256').update(glb).digest('hex')
    if (expectedGlbSha256 && actualSha256 !== expectedGlbSha256) {
        throw new Error(
            `Vehicle GLB checksum mismatch: expected ${expectedGlbSha256}, received ${actualSha256}`,
        )
    }

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
