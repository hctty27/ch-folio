import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const DEFAULT_CHUNK_COUNT = 4
const DEFAULT_GZIP_SHA256 = '39c0e04ed7824b6361b4aeab55372a083c5cacf31cf2501cd8512fd66f53aace'
const DEFAULT_GLB_SHA256 = '7f58840a2e47e02555592dab6c2a927261c1d40e3e6170eea188491b59ad335f'

function chunkGroups(count)
{
    return Array.from({ length: count }, (_, index) => [
        `part-${String(index + 1).padStart(3, '0')}.txt`,
    ])
}

export async function materializeVehicle({
    chunksDirectory,
    outputDirectory,
    expectedChunkCount = DEFAULT_CHUNK_COUNT,
    expectedGzipSha256 = expectedChunkCount === DEFAULT_CHUNK_COUNT ? DEFAULT_GZIP_SHA256 : null,
    expectedGlbSha256 = expectedChunkCount === DEFAULT_CHUNK_COUNT ? DEFAULT_GLB_SHA256 : null,
})
{
    const availableNames = new Set(await readdir(chunksDirectory))
    const groups = chunkGroups(expectedChunkCount)
    const requiredNames = groups.flat()
    const missingNames = requiredNames.filter((name) => !availableNames.has(name))

    if(missingNames.length > 0)
        throw new Error(`Incomplete vehicle chunks: missing ${missingNames.join(', ')}`)

    const encodedParts = await Promise.all(
        groups.map(async (names) =>
        {
            const segments = await Promise.all(
                names.map(async (name) => (await readFile(path.join(chunksDirectory, name), 'utf8')).trim()),
            )
            return segments.join('')
        }),
    )
    const gzip = Buffer.from(encodedParts.join(''), 'base64')

    if(gzip.length < 2 || gzip[0] !== 0x1f || gzip[1] !== 0x8b)
        throw new Error('Vehicle chunks do not decode to a gzip stream')

    const actualGzipSha256 = createHash('sha256').update(gzip).digest('hex')
    if(expectedGzipSha256 && actualGzipSha256 !== expectedGzipSha256)
    {
        throw new Error(
            `Vehicle gzip checksum mismatch: expected ${expectedGzipSha256}, received ${actualGzipSha256}`,
        )
    }

    let glb
    try
    {
        glb = gunzipSync(gzip)
    }
    catch(error)
    {
        throw new Error(`Unable to decompress vehicle asset: ${error.message}`, { cause: error })
    }

    if(glb.length < 12 || glb.subarray(0, 4).toString('ascii') !== 'glTF')
        throw new Error('Materialized vehicle is not a valid GLB file')

    const actualGlbSha256 = createHash('sha256').update(glb).digest('hex')
    if(expectedGlbSha256 && actualGlbSha256 !== expectedGlbSha256)
    {
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

if(isExecutedDirectly)
{
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    await materializeVehicle({
        chunksDirectory: path.join(repositoryRoot, 'static', 'vehicle', 'su7-original-four-wheel'),
        outputDirectory: path.join(repositoryRoot, 'static', 'vehicle'),
    })
}
