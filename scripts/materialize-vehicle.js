import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const DEFAULT_CHUNK_COUNT = 19
const DEFAULT_GZIP_SHA256 = '3303d511ffbbc94ebc02f6dd8a3b8f8bd75cf3f812c76918a1357d2dfac5b88b'
const DEFAULT_GLB_SHA256 = 'f811dd420e6860c477dfe436ae5a2ddd6e100a7ee83e258a59b8b21163d1b375'

function chunkGroups(count) {
    return Array.from({ length: count }, (_, index) => {
        const number = String(index + 1).padStart(3, '0')
        if (count === DEFAULT_CHUNK_COUNT && number === '016') {
            return Array.from(
                { length: 5 },
                (_, segment) => `part-016-${String(segment + 1).padStart(2, '0')}.txt`,
            )
        }
        return [`part-${number}.txt`]
    })
}

export async function materializeVehicle({
    chunksDirectory,
    outputDirectory,
    expectedChunkCount = DEFAULT_CHUNK_COUNT,
    expectedGzipSha256 = expectedChunkCount === DEFAULT_CHUNK_COUNT ? DEFAULT_GZIP_SHA256 : null,
    expectedGlbSha256 = expectedChunkCount === DEFAULT_CHUNK_COUNT ? DEFAULT_GLB_SHA256 : null,
}) {
    const availableNames = new Set(await readdir(chunksDirectory))
    const groups = chunkGroups(expectedChunkCount)
    const requiredNames = groups.flat()
    const missingNames = requiredNames.filter((name) => !availableNames.has(name))

    if (missingNames.length > 0)
        throw new Error(`Incomplete vehicle chunks: missing ${missingNames.join(', ')}`)

    const encodedParts = await Promise.all(
        groups.map(async (names) => {
            const segments = await Promise.all(
                names.map(async (name) => (await readFile(path.join(chunksDirectory, name), 'utf8')).trim()),
            )
            return segments.join('')
        }),
    )
    const gzip = Buffer.from(encodedParts.join(''), 'base64')

    if (gzip.length < 2 || gzip[0] !== 0x1f || gzip[1] !== 0x8b)
        throw new Error('Vehicle chunks do not decode to a gzip stream')

    const actualGzipSha256 = createHash('sha256').update(gzip).digest('hex')
    if (expectedGzipSha256 && actualGzipSha256 !== expectedGzipSha256) {
        throw new Error(
            `Vehicle gzip checksum mismatch: expected ${expectedGzipSha256}, received ${actualGzipSha256}`,
        )
    }

    let glb
    try {
        glb = gunzipSync(gzip)
    }
    catch (error) {
        throw new Error(`Unable to decompress vehicle asset: ${error.message}`, { cause: error })
    }

    if (glb.length < 12 || glb.subarray(0, 4).toString('ascii') !== 'glTF')
        throw new Error('Materialized vehicle is not a valid GLB file')

    const actualGlbSha256 = createHash('sha256').update(glb).digest('hex')
    if (expectedGlbSha256 && actualGlbSha256 !== expectedGlbSha256) {
        throw new Error(
            `Vehicle GLB checksum mismatch: expected ${expectedGlbSha256}, received ${actualGlbSha256}`,
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
