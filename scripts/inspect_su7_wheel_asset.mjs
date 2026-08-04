import { readFile } from 'node:fs/promises'
import path from 'node:path'

function readGlbJson(buffer)
{
    if(buffer.length < 20 || buffer.subarray(0, 4).toString('ascii') !== 'glTF')
        throw new Error('Expected a GLB 2.0 file')

    const version = buffer.readUInt32LE(4)
    const declaredLength = buffer.readUInt32LE(8)
    if(version !== 2 || declaredLength !== buffer.length)
        throw new Error(`Invalid GLB header: version=${version}, length=${declaredLength}/${buffer.length}`)

    let offset = 12
    while(offset < buffer.length)
    {
        const chunkLength = buffer.readUInt32LE(offset)
        const chunkType = buffer.readUInt32LE(offset + 4)
        offset += 8
        const chunk = buffer.subarray(offset, offset + chunkLength)
        offset += chunkLength

        if(chunkType === 0x4E4F534A)
            return JSON.parse(chunk.toString('utf8').replace(/[\u0000\s]+$/u, ''))
    }

    throw new Error('GLB JSON chunk not found')
}

function meshDetails(document, meshIndex)
{
    if(meshIndex === undefined)
        return null

    const mesh = document.meshes?.[meshIndex]
    return (mesh?.primitives ?? []).map((primitive) =>
    {
        const accessorIndex = primitive.attributes?.POSITION
        const accessor = document.accessors?.[accessorIndex]
        const material = document.materials?.[primitive.material]
        const min = accessor?.min ?? null
        const max = accessor?.max ?? null
        const extents = min && max ? max.map((value, axis) => value - min[axis]) : null
        return {
            material: material?.name ?? null,
            positionAccessor: accessorIndex ?? null,
            min,
            max,
            extents,
        }
    })
}

function printNodeTree(document)
{
    const nodes = document.nodes ?? []
    const childIndices = new Set(nodes.flatMap((node) => node.children ?? []))
    const roots = nodes.map((_, index) => index).filter((index) => !childIndices.has(index))

    const visit = (index, depth = 0) =>
    {
        const node = nodes[index]
        const name = node.name ?? `<node-${index}>`
        const relevant = /wheel|chassis|bodypainted/i.test(name)
        if(relevant)
        {
            console.log(JSON.stringify({
                depth,
                index,
                name,
                mesh: node.mesh ?? null,
                translation: node.translation ?? [0, 0, 0],
                rotation: node.rotation ?? [0, 0, 0, 1],
                scale: node.scale ?? [1, 1, 1],
                children: node.children ?? [],
                primitives: meshDetails(document, node.mesh),
            }))
        }

        for(const child of node.children ?? [])
            visit(child, depth + 1)
    }

    for(const root of roots)
        visit(root)
}

const input = path.resolve(process.argv[2] ?? 'static/vehicle/default.glb')
const document = readGlbJson(await readFile(input))

console.log(JSON.stringify({
    input,
    nodes: document.nodes?.length ?? 0,
    meshes: document.meshes?.length ?? 0,
    materials: document.materials?.length ?? 0,
}))
printNodeTree(document)
