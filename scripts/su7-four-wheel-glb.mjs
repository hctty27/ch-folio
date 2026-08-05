const JSON_CHUNK_TYPE = 0x4E4F534A
const GLB_MAGIC = 'glTF'
const GLB_VERSION = 2

export const SU7_SOURCE_UNIFORM_CORRECTION = Object.freeze({
    scale: Object.freeze([0.999978602599, 0.537244218674, 0.680941334619]),
    translation: Object.freeze([0.000014726447, -0.496444948533, 0]),
})

export const SU7_WHEEL_SLOTS = Object.freeze([
    Object.freeze({ key: 'frontRight', rootName: 'wheelFrontRight', position: [0.9000000000000001, -0.7651057827609948, 0.5013035422768598], front: true, mirror: false }),
    Object.freeze({ key: 'frontLeft', rootName: 'wheelFrontLeft', position: [0.896241546453129, -0.7650828866856558, -0.5140253043151006], front: true, mirror: true }),
    Object.freeze({ key: 'rearRight', rootName: 'wheelRearRight', position: [-0.8861616712125657, -0.7650839590730645, 0.518279359437324], front: false, mirror: false }),
    Object.freeze({ key: 'rearLeft', rootName: 'wheelRearLeft', position: [-0.9000000000000001, -0.7650839647370825, -0.5165352194932844], front: false, mirror: true }),
])

function pad4(length)
{
    return (4 - (length % 4)) % 4
}

export function parseGlb(buffer)
{
    if(buffer.length < 20 || buffer.subarray(0, 4).toString('ascii') !== GLB_MAGIC)
        throw new Error('Expected a GLB 2.0 file')

    const version = buffer.readUInt32LE(4)
    const declaredLength = buffer.readUInt32LE(8)
    if(version !== GLB_VERSION || declaredLength !== buffer.length)
        throw new Error(`Invalid GLB header: version=${version}, length=${declaredLength}/${buffer.length}`)

    const chunks = []
    let offset = 12
    while(offset < buffer.length)
    {
        const length = buffer.readUInt32LE(offset)
        const type = buffer.readUInt32LE(offset + 4)
        offset += 8
        const data = Buffer.from(buffer.subarray(offset, offset + length))
        offset += length
        chunks.push({ type, data })
    }

    const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK_TYPE)
    if(!jsonChunk)
        throw new Error('GLB JSON chunk not found')

    return {
        document: JSON.parse(jsonChunk.data.toString('utf8').replace(/[\u0000\u0020]+$/g, '')),
        chunks: chunks.filter((chunk) => chunk.type !== JSON_CHUNK_TYPE),
    }
}

export function writeGlb(document, otherChunks = [])
{
    const json = Buffer.from(JSON.stringify(document), 'utf8')
    const jsonData = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)])
    const chunks = [{ type: JSON_CHUNK_TYPE, data: jsonData }, ...otherChunks]
    const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0)
    const output = Buffer.alloc(totalLength)

    output.write(GLB_MAGIC, 0, 4, 'ascii')
    output.writeUInt32LE(GLB_VERSION, 4)
    output.writeUInt32LE(totalLength, 8)

    let offset = 12
    for(const chunk of chunks)
    {
        output.writeUInt32LE(chunk.data.length, offset)
        output.writeUInt32LE(chunk.type, offset + 4)
        chunk.data.copy(output, offset + 8)
        offset += 8 + chunk.data.length
    }
    return output
}

function addNode(document, node)
{
    document.nodes ??= []
    document.nodes.push(node)
    return document.nodes.length - 1
}

function findNodeIndex(document, name)
{
    return document.nodes?.findIndex((node) => node.name === name) ?? -1
}

function cloneTransform(node)
{
    const result = {}
    for(const key of ['translation', 'rotation', 'scale', 'matrix', 'weights'])
    {
        if(node[key] !== undefined)
            result[key] = Array.isArray(node[key]) ? [...node[key]] : node[key]
    }
    return result
}

function materialNameForNode(document, node)
{
    if(node.mesh === undefined)
        return ''
    const mesh = document.meshes?.[node.mesh]
    return (mesh?.primitives ?? [])
        .map((primitive) => document.materials?.[primitive.material]?.name ?? '')
        .join(' ')
}

function boundsForNode(document, node)
{
    const mesh = node.mesh === undefined ? null : document.meshes?.[node.mesh]
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for(const primitive of mesh?.primitives ?? [])
    {
        const accessor = document.accessors?.[primitive.attributes?.POSITION]
        if(!accessor?.min || !accessor?.max)
            continue
        for(let axis = 0; axis < 3; axis++)
        {
            bounds.min[axis] = Math.min(bounds.min[axis], accessor.min[axis])
            bounds.max[axis] = Math.max(bounds.max[axis], accessor.max[axis])
        }
    }
    return bounds
}

function addTransformChain(document, parentIndex, names, transforms, leafIndices)
{
    let current = parentIndex
    for(let index = 0; index < names.length; index++)
    {
        const child = addNode(document, {
            name: names[index],
            ...transforms[index],
            children: [],
        })
        document.nodes[current].children ??= []
        document.nodes[current].children.push(child)
        current = child
    }
    document.nodes[current].children.push(...leafIndices)
}

function cloneMeshNodes(document, items, slot, rolePrefix)
{
    return items.map((item, itemIndex) => addNode(document, {
        ...cloneTransform(item.node),
        name: item.role === 'rim'
            ? `wheelPainted_${slot.key}`
            : `${slot.rootName}${rolePrefix}${itemIndex}`,
        mesh: item.node.mesh,
    }))
}

export function prepareSU7FourWheelDocument(document)
{
    const requiredRoots = SU7_WHEEL_SLOTS.map((slot) => slot.rootName)
    if(requiredRoots.every((name) => findNodeIndex(document, name) >= 0))
        return { changed: false }

    const chassisIndex = findNodeIndex(document, 'chassis')
    const containerIndex = findNodeIndex(document, 'wheelContainer')
    const cylinderIndex = findNodeIndex(document, 'wheelCylinder')
    if(chassisIndex < 0 || containerIndex < 0 || cylinderIndex < 0)
        throw new Error('SU7 source asset is missing chassis/wheelContainer/wheelCylinder')

    const cylinder = document.nodes[cylinderIndex]
    const sourceItems = (cylinder.children ?? []).map((index) =>
    {
        const node = document.nodes[index]
        const materialName = materialNameForNode(document, node)
        const role = /brake/i.test(materialName)
            ? 'brake'
            : /wheel/i.test(materialName)
                ? 'rim'
                : 'tire'
        return { index, node, role }
    })
    const rollItems = sourceItems.filter(({ role }) => role !== 'brake')
    const brakeItems = sourceItems.filter(({ role }) => role === 'brake')
    if(rollItems.length === 0 || brakeItems.length === 0)
        throw new Error('SU7 wheel template does not contain rolling and brake meshes')

    const rollBounds = rollItems.reduce((result, item) =>
    {
        const itemBounds = boundsForNode(document, item.node)
        for(let axis = 0; axis < 3; axis++)
        {
            result.min[axis] = Math.min(result.min[axis], itemBounds.min[axis])
            result.max[axis] = Math.max(result.max[axis], itemBounds.max[axis])
        }
        return result
    }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
    const center = rollBounds.min.map((value, axis) => (value + rollBounds.max[axis]) * 0.5)

    const chassis = document.nodes[chassisIndex]
    chassis.children ??= []
    const bodyChildren = chassis.children.filter((index) => index !== containerIndex)
    const bodyCorrectionIndex = addNode(document, {
        name: 'bodyUniformCorrection',
        translation: [...SU7_SOURCE_UNIFORM_CORRECTION.translation],
        scale: [...SU7_SOURCE_UNIFORM_CORRECTION.scale],
        children: bodyChildren,
    })
    const cockpitIndex = addNode(document, {
        name: 'cockpitCamera',
        translation: [0.22, -0.30, 0],
    })
    chassis.children = [containerIndex, bodyCorrectionIndex, cockpitIndex]

    const offsetTransform = { translation: center.map((value) => -value) }
    const cylinderTransform = cloneTransform(cylinder)
    delete cylinderTransform.translation
    if(cylinder.translation)
        cylinderTransform.translation = [...cylinder.translation]

    for(const slot of SU7_WHEEL_SLOTS)
    {
        const rootIndex = addNode(document, {
            name: slot.rootName,
            translation: [...slot.position],
            children: [],
        })
        chassis.children.push(rootIndex)

        let steeringParent = rootIndex
        if(slot.front)
        {
            steeringParent = addNode(document, {
                name: `${slot.rootName}Steer`,
                children: [],
            })
            document.nodes[rootIndex].children.push(steeringParent)
        }

        const rollIndex = addNode(document, { name: `${slot.rootName}Roll`, children: [] })
        const brakeIndex = addNode(document, { name: `${slot.rootName}Brake`, children: [] })
        document.nodes[steeringParent].children.push(rollIndex, brakeIndex)

        const mirrorRotation = slot.mirror ? [0, 1, 0, 0] : [0, 0, 0, 1]
        const scaleTransform = { scale: [...SU7_SOURCE_UNIFORM_CORRECTION.scale] }

        addTransformChain(
            document,
            rollIndex,
            [`${slot.rootName}RollMirror`, `${slot.rootName}RollUniform`, `${slot.rootName}RollOffset`, `${slot.rootName}RollSource`],
            [{ rotation: mirrorRotation }, scaleTransform, offsetTransform, cylinderTransform],
            cloneMeshNodes(document, rollItems, slot, 'RollPart'),
        )
        addTransformChain(
            document,
            brakeIndex,
            [`${slot.rootName}BrakeMirror`, `${slot.rootName}BrakeUniform`, `${slot.rootName}BrakeOffset`, `${slot.rootName}BrakeSource`],
            [{ rotation: mirrorRotation }, scaleTransform, offsetTransform, cylinderTransform],
            cloneMeshNodes(document, brakeItems, slot, 'BrakePart'),
        )
    }

    document.asset ??= { version: '2.0' }
    document.asset.extras ??= {}
    document.asset.extras.chFolioSU7FourWheel = {
        version: 4,
        source: 'original-su7-uniform-correction',
        bodyScale: [...SU7_SOURCE_UNIFORM_CORRECTION.scale],
        bodyTranslation: [...SU7_SOURCE_UNIFORM_CORRECTION.translation],
        wheelCenters: SU7_WHEEL_SLOTS.map(({ key, position }) => ({ key, position: [...position] })),
    }

    return {
        changed: true,
        center,
        bodyScale: [...SU7_SOURCE_UNIFORM_CORRECTION.scale],
        bodyTranslation: [...SU7_SOURCE_UNIFORM_CORRECTION.translation],
    }
}

export function rewriteSU7FourWheelGlb(buffer)
{
    const parsed = parseGlb(buffer)
    const result = prepareSU7FourWheelDocument(parsed.document)
    return {
        ...result,
        buffer: result.changed ? writeGlb(parsed.document, parsed.chunks) : buffer,
    }
}
