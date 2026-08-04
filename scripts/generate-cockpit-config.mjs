import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK_TYPE = 0x4e4f534a
const ANCHOR_PATTERN = /(driver.?camera|cockpit.?camera|camera.?anchor|driver.?view)/i
const INTERIOR_PATTERN = /(interior|dashboard|dash|cockpit|steering|seat|windshield|windscreen|glass|door.?trim|pillar|mirror)/i
const STEERING_WHEEL_PATTERN = /(steering.?wheel|steeringwheel|volant)/i

function readGlbJson(buffer)
{
    if(buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC)
        throw new Error('Vehicle file is not a valid binary glTF asset')

    const declaredLength = buffer.readUInt32LE(8)
    if(declaredLength > buffer.length)
        throw new Error(`Vehicle GLB is truncated: expected ${declaredLength} bytes, received ${buffer.length}`)

    let offset = 12
    while(offset + 8 <= declaredLength)
    {
        const chunkLength = buffer.readUInt32LE(offset)
        const chunkType = buffer.readUInt32LE(offset + 4)
        const chunkStart = offset + 8
        const chunkEnd = chunkStart + chunkLength

        if(chunkEnd > declaredLength)
            throw new Error('Vehicle GLB contains an invalid chunk length')

        if(chunkType === JSON_CHUNK_TYPE)
        {
            const json = buffer
                .subarray(chunkStart, chunkEnd)
                .toString('utf8')
                .replace(/[\u0000\u0020]+$/u, '')
            return JSON.parse(json)
        }

        offset = chunkEnd
    }

    throw new Error('Vehicle GLB does not contain a JSON chunk')
}

const uniqueMatches = (values, pattern) => [ ...new Set(values.filter((value) => pattern.test(value))) ]

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = path.join(repositoryRoot, 'static', 'vehicle', 'default.glb')
const outputPath = path.join(repositoryRoot, 'sources', 'data', 'cockpit.generated.json')

const gltf = readGlbJson(await readFile(inputPath))
const nodeNames = (gltf.nodes || []).map((node) => (node.name || '').trim()).filter(Boolean)
const materialNames = (gltf.materials || []).map((material) => (material.name || '').trim()).filter(Boolean)

const config = {
    generatedAt: new Date().toISOString(),
    nodeCount: gltf.nodes?.length || 0,
    meshCount: gltf.meshes?.length || 0,
    materialCount: gltf.materials?.length || 0,
    anchorNodeNames: uniqueMatches(nodeNames, ANCHOR_PATTERN),
    interiorNodeNames: uniqueMatches([ ...nodeNames, ...materialNames ], INTERIOR_PATTERN),
    steeringWheelNodeNames: uniqueMatches(nodeNames, STEERING_WHEEL_PATTERN),
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`)

if(config.interiorNodeNames.length === 0)
    console.warn('[cockpit-config] no named interior nodes were detected; runtime geometric fallback will be used')

console.log('[cockpit-config]', config)
