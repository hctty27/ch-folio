import assert from 'node:assert/strict'
import test from 'node:test'

import {
    SU7_WHEEL_SLOTS,
    parseGlb,
    prepareSU7FourWheelDocument,
    rewriteSU7FourWheelGlb,
    writeGlb,
} from './su7-four-wheel-glb.mjs'

const BIN_CHUNK_TYPE = 0x004E4942

function createDocument({ axle = 'z' } = {})
{
    const bounds = axle === 'z'
        ? { min: [-0.4, -0.4, -0.1], max: [0.4, 0.4, 0.1] }
        : { min: [-0.1, -0.4, -0.4], max: [0.1, 0.4, 0.4] }

    return {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        scene: 0,
        nodes: [
            { name: 'chassis', children: [1] },
            { name: 'wheelContainer', translation: [1000, 0, 1000], children: [2] },
            { name: 'wheelCylinder', translation: [0.05, 0, 0], children: [3, 4, 5, 6] },
            { name: 'wheelPart_tireA', mesh: 0 },
            { name: 'wheelPart_brake', mesh: 1 },
            { name: 'wheelPart_rim', mesh: 2 },
            { name: 'wheelPart_tireB', mesh: 3 },
        ],
        materials: [
            { name: 'su7_tire' },
            { name: 'su7_brake' },
            { name: 'su7_wheel' },
        ],
        meshes: [
            { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
            { primitives: [{ attributes: { POSITION: 1 }, material: 1 }] },
            { primitives: [{ attributes: { POSITION: 2 }, material: 2 }] },
            { primitives: [{ attributes: { POSITION: 3 }, material: 0 }] },
        ],
        accessors: [bounds, bounds, bounds, bounds],
    }
}

function childByName(document, parentName, childName)
{
    const parent = document.nodes.find((node) => node.name === parentName)
    assert.ok(parent, `missing parent ${parentName}`)
    const childIndex = (parent.children ?? []).find((index) => document.nodes[index].name === childName)
    assert.notEqual(childIndex, undefined, `missing child ${childName} below ${parentName}`)
    return document.nodes[childIndex]
}

function descendants(document, rootName)
{
    const rootIndex = document.nodes.findIndex((node) => node.name === rootName)
    assert.notEqual(rootIndex, -1)
    const result = []
    const visit = (index) =>
    {
        result.push(document.nodes[index])
        for(const child of document.nodes[index].children ?? [])
            visit(child)
    }
    visit(rootIndex)
    return result
}

test('creates four independent wheel roots in physical wheel order', () =>
{
    const document = createDocument()
    const result = prepareSU7FourWheelDocument(document)

    assert.equal(result.changed, true)
    const chassis = document.nodes.find((node) => node.name === 'chassis')
    const rootNames = chassis.children.map((index) => document.nodes[index].name)

    for(const slot of SU7_WHEEL_SLOTS)
    {
        assert.ok(rootNames.includes(slot.rootName))
        const root = document.nodes.find((node) => node.name === slot.rootName)
        assert.deepEqual(root.translation, slot.position)
        childByName(document, slot.rootName, slot.front ? `${slot.rootName}Steer` : `${slot.rootName}Roll`)
    }
})

test('keeps rolling meshes below roll pivot and brake meshes outside it', () =>
{
    const document = createDocument()
    prepareSU7FourWheelDocument(document)

    for(const slot of SU7_WHEEL_SLOTS)
    {
        const rollNodes = descendants(document, `${slot.rootName}Roll`)
        const brakeNodes = descendants(document, `${slot.rootName}Brake`)
        const rollMaterialMeshes = rollNodes.filter((node) => node.mesh !== undefined)
        const brakeMaterialMeshes = brakeNodes.filter((node) => node.mesh !== undefined)

        assert.equal(rollMaterialMeshes.length, 3)
        assert.equal(brakeMaterialMeshes.length, 1)
        assert.ok(rollMaterialMeshes.some((node) => node.name === `wheelPainted_${slot.key}`))
        assert.ok(brakeMaterialMeshes.every((node) => node.name.includes('BrakePart')))
    }
})

test('corrects non-uniform rolling-plane scale before wheel rotation', () =>
{
    const document = createDocument()
    for(const accessor of document.accessors)
    {
        accessor.min = [-0.215, -0.4, -0.107]
        accessor.max = [0.215, 0.4, 0.107]
    }

    const result = prepareSU7FourWheelDocument(document)
    const aspectNode = document.nodes.find((node) => node.name === 'wheelFrontRightRollAspect')

    assert.ok(Math.abs(result.aspectScale[0] - (0.8 / 0.43)) < 1e-9)
    assert.equal(result.aspectScale[1], 1)
    assert.equal(result.aspectScale[2], 1)
    assert.deepEqual(aspectNode.scale, result.aspectScale)
})

test('bakes non-Z source axle into a dedicated correction node', () =>
{
    const document = createDocument({ axle: 'x' })
    const result = prepareSU7FourWheelDocument(document)

    assert.equal(result.axleAxis, 'x')
    const axisNode = document.nodes.find((node) => node.name === 'wheelFrontRightRollAxis')
    assert.notDeepEqual(axisNode.rotation, [0, 0, 0, 1])
})

test('is idempotent and preserves the legacy template for fallback', () =>
{
    const document = createDocument()
    prepareSU7FourWheelDocument(document)
    const nodeCount = document.nodes.length
    const second = prepareSU7FourWheelDocument(document)

    assert.equal(second.changed, false)
    assert.equal(document.nodes.length, nodeCount)
    assert.ok(document.nodes.some((node) => node.name === 'wheelContainer'))
    assert.ok(document.nodes.some((node) => node.name === 'wheelCylinder'))
})

test('rewrites only the JSON chunk and preserves binary bytes', () =>
{
    const document = createDocument()
    const binary = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    const input = writeGlb(document, [{ type: BIN_CHUNK_TYPE, data: binary }])
    const result = rewriteSU7FourWheelGlb(input)
    const parsed = parseGlb(result.buffer)
    const binChunk = parsed.chunks.find((chunk) => chunk.type === BIN_CHUNK_TYPE)

    assert.equal(result.changed, true)
    assert.deepEqual(binChunk.data, binary)
    assert.ok(parsed.document.nodes.some((node) => node.name === 'wheelRearLeftRoll'))
})
