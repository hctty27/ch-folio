const JSON_CHUNK_TYPE = 0x4E4F534A
const GLB_MAGIC = 'glTF'
const GLB_VERSION = 2

export const SU7_WHEEL_SLOTS = Object.freeze([
    Object.freeze({ key: 'frontRight', rootName: 'wheelFrontRight', position: [0.9, -0.5, 0.75], front: true, mirror: true }),
    Object.freeze({ key: 'frontLeft', rootName: 'wheelFrontLeft', position: [0.9, -0.5, -0.75], front: true, mirror: false }),
    Object.freeze({ key: 'rearRight', rootName: 'wheelRearRight', position: [-0.9, -0.5, 0.75], front: false, mirror: true }),
    Object.freeze({ key: 'rearLeft', rootName: 'wheelRearLeft', position: [-0.9, -0.5, -0.75], front: false, mirror: false }),
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

    const document = JSON.parse(jsonChunk.data.toString('utf8').replace(/[\u0000\s]+$/u, ''))
    return { document, chunks }
}

export function writeGlb(document, sourceChunks)
{
    const json = Buffer.from(JSON.stringify(document), 'utf8')
    const jsonPadding = Buffer.alloc(pad4(json.length), 0x20)
    const jsonData = Buffer.concat([json, jsonPadding])
    const chunks = [
        { type: JSON_CHUNK_TYPE, data: jsonData },
        ...sourceChunks.filter((chunk) => chunk.type !== JSON_CHUNK_TYPE),
    ]

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

function findNodeIndex(document, name)
{
    return (document.nodes ?? []).findIndex((node) => node.name === name)
}

function multiplyMatrices(a, b)
{
    const out = new Array(16).fill(0)
    for(let column = 0; column < 4; column++)
    {
        for(let row = 0; row < 4; row++)
        {
            for(let k = 0; k < 4; k++)
                out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k]
        }
    }
    return out
}

function matrixFromNode(node)
{
    if(node.matrix)
        return [...node.matrix]

    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
    const [sx, sy, sz] = node.scale ?? [1, 1, 1]
    const [tx, ty, tz] = node.translation ?? [0, 0, 0]

    const xx = x * x
    const yy = y * y
    const zz = z * z
    const xy = x * y
    const xz = x * z
    const yz = y * z
    const wx = w * x
    const wy = w * y
    const wz = w * z

    return [
        (1 - 2 * (yy + zz)) * sx,
        (2 * (xy + wz)) * sx,
        (2 * (xz - wy)) * sx,
        0,
        (2 * (xy - wz)) * sy,
        (1 - 2 * (xx + zz)) * sy,
        (2 * (yz + wx)) * sy,
        0,
        (2 * (xz + wy)) * sz,
        (2 * (yz - wx)) * sz,
        (1 - 2 * (xx + yy)) * sz,
        0,
        tx,
        ty,
        tz,
        1,
    ]
}

function transformPoint(matrix, point)
{
    const [x, y, z] = point
    return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ]
}

function accessorBounds(document, accessorIndex)
{
    const accessor = document.accessors?.[accessorIndex]
    if(!accessor?.min || !accessor?.max)
        throw new Error(`POSITION accessor ${accessorIndex} is missing min/max bounds`)
    return { min: accessor.min, max: accessor.max }
}

function meshBounds(document, meshIndex)
{
    const mesh = document.meshes?.[meshIndex]
    if(!mesh)
        throw new Error(`Missing mesh ${meshIndex}`)

    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for(const primitive of mesh.primitives ?? [])
    {
        const positionAccessor = primitive.attributes?.POSITION
        if(positionAccessor === undefined)
            continue
        const bounds = accessorBounds(document, positionAccessor)
        for(let axis = 0; axis < 3; axis++)
        {
            min[axis] = Math.min(min[axis], bounds.min[axis])
            max[axis] = Math.max(max[axis], bounds.max[axis])
        }
    }

    if(!Number.isFinite(min[0]))
        throw new Error(`Mesh ${meshIndex} has no bounded POSITION accessor`)
    return { min, max }
}

function transformedBounds(bounds, matrix)
{
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for(const x of [bounds.min[0], bounds.max[0]])
    {
        for(const y of [bounds.min[1], bounds.max[1]])
        {
            for(const z of [bounds.min[2], bounds.max[2]])
            {
                const point = transformPoint(matrix, [x, y, z])
                for(let axis = 0; axis < 3; axis++)
                {
                    min[axis] = Math.min(min[axis], point[axis])
                    max[axis] = Math.max(max[axis], point[axis])
                }
            }
        }
    }
    return { min, max }
}

function unionBounds(items)
{
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for(const bounds of items)
    {
        for(let axis = 0; axis < 3; axis++)
        {
            min[axis] = Math.min(min[axis], bounds.min[axis])
            max[axis] = Math.max(max[axis], bounds.max[axis])
        }
    }
    return { min, max }
}

function materialNamesForNode(document, node)
{
    if(node.mesh === undefined)
        return []
    const mesh = document.meshes?.[node.mesh]
    return (mesh?.primitives ?? []).map((primitive) =>
    {
        const material = document.materials?.[primitive.material]
        return material?.name ?? ''
    })
}

function classifyTemplateNode(document, node)
{
    const names = materialNamesForNode(document, node).join(' ').toLowerCase()
    const nodeName = (node.name ?? '').toLowerCase()
    if(names.includes('brake') || nodeName.includes('brake'))
        return 'brake'
    if(names.includes('wheel') || names.includes('rim') || nodeName.includes('rim'))
        return 'rim'
    if(names.includes('tire') || names.includes('tyre'))
        return 'tire'
    return 'roll'
}

function quaternionForAxisCorrection(axisIndex)
{
    const half = Math.PI / 4
    if(axisIndex === 0)
        return [0, -Math.sin(half), 0, Math.cos(half)]
    if(axisIndex === 1)
        return [Math.sin(half), 0, 0, Math.cos(half)]
    return [0, 0, 0, 1]
}

function cloneTransform(node)
{
    const result = {}
    for(const key of ['matrix', 'translation', 'rotation', 'scale', 'weights', 'extras', 'extensions'])
    {
        if(node[key] !== undefined)
            result[key] = structuredClone(node[key])
    }
    return result
}

function addNode(document, node)
{
    document.nodes ??= []
    document.nodes.push(node)
    return document.nodes.length - 1
}

function addTransformChain(document, parentIndex, names, transforms, leafChildren)
{
    let currentParent = parentIndex
    for(let i = 0; i < names.length; i++)
    {
        const index = addNode(document, {
            name: names[i],
            ...transforms[i],
            children: [],
        })
        document.nodes[currentParent].children ??= []
        document.nodes[currentParent].children.push(index)
        currentParent = index
    }
    document.nodes[currentParent].children = leafChildren
}

export function prepareSU7FourWheelDocument(document)
{
    document.nodes ??= []
    const existing = SU7_WHEEL_SLOTS.every((slot) => findNodeIndex(document, slot.rootName) >= 0)
    if(existing)
        return { changed: false, reason: 'already-prepared' }

    const chassisIndex = findNodeIndex(document, 'chassis')
    const containerIndex = findNodeIndex(document, 'wheelContainer')
    const cylinderIndex = findNodeIndex(document, 'wheelCylinder')
    if(chassisIndex < 0 || containerIndex < 0 || cylinderIndex < 0)
        throw new Error('Expected chassis, wheelContainer, and wheelCylinder nodes')

    const cylinder = document.nodes[cylinderIndex]
    const templateChildren = (cylinder.children ?? [])
        .map((index) => ({ index, node: document.nodes[index] }))
        .filter(({ node }) => node?.mesh !== undefined)
    if(templateChildren.length < 2)
        throw new Error('wheelCylinder does not contain enough mesh children')

    const classified = templateChildren.map((item) => ({
        ...item,
        role: classifyTemplateNode(document, item.node),
    }))
    const rollItems = classified.filter((item) => item.role !== 'brake')
    const brakeItems = classified.filter((item) => item.role === 'brake')
    if(rollItems.length === 0 || brakeItems.length === 0)
        throw new Error('Unable to distinguish rolling and brake wheel parts')

    const cylinderMatrix = matrixFromNode(cylinder)
    const rollBounds = unionBounds(rollItems.map(({ node }) =>
    {
        const matrix = multiplyMatrices(cylinderMatrix, matrixFromNode(node))
        return transformedBounds(meshBounds(document, node.mesh), matrix)
    }))
    const center = rollBounds.min.map((value, axis) => (value + rollBounds.max[axis]) * 0.5)
    const extents = rollBounds.min.map((value, axis) => rollBounds.max[axis] - value)
    const axleAxis = extents.indexOf(Math.min(...extents))
    const axisCorrection = quaternionForAxisCorrection(axleAxis)
    const rollingPlaneAxes = [0, 1, 2].filter((axis) => axis !== axleAxis)
    const rollingDiameter = Math.max(...rollingPlaneAxes.map((axis) => extents[axis]))
    const aspectScale = extents.map((extent, axis) =>
        axis === axleAxis ? 1 : rollingDiameter / extent)

    const cloneMeshNodes = (items, slot, rolePrefix) => items.map((item, itemIndex) =>
    {
        const name = item.role === 'rim'
            ? `wheelPainted_${slot.key}`
            : `${slot.rootName}${rolePrefix}${itemIndex}`
        return addNode(document, {
            ...cloneTransform(item.node),
            name,
            mesh: item.node.mesh,
        })
    })

    const chassis = document.nodes[chassisIndex]
    chassis.children ??= []

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

        const rollIndex = addNode(document, {
            name: `${slot.rootName}Roll`,
            children: [],
        })
        const brakeIndex = addNode(document, {
            name: `${slot.rootName}Brake`,
            children: [],
        })
        document.nodes[steeringParent].children.push(rollIndex, brakeIndex)

        const mirrorRotation = slot.mirror ? [0, 1, 0, 0] : [0, 0, 0, 1]
        const offsetTransform = { translation: center.map((value) => -value) }
        const cylinderTransform = cloneTransform(cylinder)
        delete cylinderTransform.translation
        if(cylinder.translation)
            cylinderTransform.translation = [...cylinder.translation]

        const rollMeshNodes = cloneMeshNodes(rollItems, slot, 'RollPart')
        addTransformChain(
            document,
            rollIndex,
            [`${slot.rootName}RollMirror`, `${slot.rootName}RollAxis`, `${slot.rootName}RollAspect`, `${slot.rootName}RollOffset`, `${slot.rootName}RollSource`],
            [{ rotation: mirrorRotation }, { rotation: axisCorrection }, { scale: aspectScale }, offsetTransform, cylinderTransform],
            rollMeshNodes,
        )

        const brakeMeshNodes = cloneMeshNodes(brakeItems, slot, 'BrakePart')
        addTransformChain(
            document,
            brakeIndex,
            [`${slot.rootName}BrakeMirror`, `${slot.rootName}BrakeAxis`, `${slot.rootName}BrakeAspect`, `${slot.rootName}BrakeOffset`, `${slot.rootName}BrakeSource`],
            [{ rotation: mirrorRotation }, { rotation: axisCorrection }, { scale: aspectScale }, offsetTransform, cylinderTransform],
            brakeMeshNodes,
        )
    }

    document.asset ??= { version: '2.0' }
    document.asset.extras ??= {}
    document.asset.extras.chFolioSU7FourWheel = {
        version: 1,
        source: 'wheelContainer/wheelCylinder',
        center,
        extents,
        originalAxleAxis: ['x', 'y', 'z'][axleAxis],
        runtimeRollAxis: 'z',
        aspectScale,
    }

    return {
        changed: true,
        center,
        extents,
        axleAxis: ['x', 'y', 'z'][axleAxis],
        aspectScale,
    }
}

export function rewriteSU7FourWheelGlb(buffer)
{
    const { document, chunks } = parseGlb(buffer)
    const result = prepareSU7FourWheelDocument(document)
    return {
        ...result,
        buffer: result.changed ? writeGlb(document, chunks) : buffer,
        document,
    }
}
