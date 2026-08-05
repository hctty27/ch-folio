import assert from 'node:assert/strict'
import test from 'node:test'

import {
    SU7_SOURCE_UNIFORM_CORRECTION,
    SU7_WHEEL_SLOTS,
    parseGlb,
    prepareSU7FourWheelDocument,
    rewriteSU7FourWheelGlb,
    writeGlb,
} from './su7-four-wheel-glb.mjs'

const BIN_CHUNK_TYPE = 0x004E4942

function createDocument()
{
    const bounds = { min: [-0.215, -0.4, -0.11], max: [0.215, 0.4, 0.11] }
    return {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        scene: 0,
        nodes: [
            { name: 'chassis', children: [1, 7, 8] },
            { name: 'wheelContainer', translation: [1000, 0, 1000], children: [2] },
            { name: 'wheelCylinder', children: [3, 4, 5, 6] },
            { name: 'wheelPart_tireA', mesh: 0 },
            { name: 'wheelPart_brake', mesh: 1 },
            { name: 'wheelPart_rim', mesh: 2 },
            { name: 'wheelPart_tireB', mesh: 3 },
            { name: 'bodyPainted' },
            { name: 'common_body' },
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

test('restores source-derived uniform body proportions without bodyVisualCorrection', () =>
{
    const document = createDocument()
    const result = prepareSU7FourWheelDocument(document)

    assert.equal(result.changed, true)
    const correction = childByName(document, 'chassis', 'bodyUniformCorrection')
    assert.deepEqual(correction.scale, [...SU7_SOURCE_UNIFORM_CORRECTION.scale])
    assert.deepEqual(correction.translation, [...SU7_SOURCE_UNIFORM_CORRECTION.translation])
    assert.deepEqual(
        correction.children.map((index) => document.nodes[index].name).sort(),
        ['bodyPainted', 'common_body'],
    )
    assert.equal(document.nodes.some((node) => node.name === 'bodyVisualCorrection'), false)
    childByName(document, 'chassis', 'cockpitCamera')
})

test('creates four wheel roots at centers recovered from the original OBJ', () =>
{
    const document = createDocument()
    prepareSU7FourWheelDocument(document)

    for(const slot of SU7_WHEEL_SLOTS)
    {
        const root = childByName(document, 'chassis', slot.rootName)
        assert.deepEqual(root.translation, slot.position)
        childByName(document, slot.rootName, slot.front ? `${slot.rootName}Steer` : `${slot.rootName}Roll`)
    }
})

test('applies the same source-derived uniform correction to tire, rim and brake nodes', () =>
{
    const document = createDocument()
    prepareSU7FourWheelDocument(document)

    assert.deepEqual(
        document.nodes.find((node) => node.name === 'wheelFrontRightRollUniform').scale,
        [...SU7_SOURCE_UNIFORM_CORRECTION.scale],
    )
    assert.deepEqual(
        document.nodes.find((node) => node.name === 'wheelFrontRightBrakeUniform').scale,
        [...SU7_SOURCE_UNIFORM_CORRECTION.scale],
    )
})

test('keeps the source right wheel orientation and mirrors only left wheels', () =>
{
    const document = createDocument()
    prepareSU7FourWheelDocument(document)

    assert.deepEqual(document.nodes.find((node) => node.name === 'wheelFrontRightRollMirror').rotation, [0, 0, 0, 1])
    assert.deepEqual(document.nodes.find((node) => node.name === 'wheelFrontLeftRollMirror').rotation, [0, 1, 0, 0])
})

test('is idempotent and preserves the parked legacy wheel template', () =>
{
    const document = createDocument()
    prepareSU7FourWheelDocument(document)
    const count = document.nodes.length
    const second = prepareSU7FourWheelDocument(document)

    assert.equal(second.changed, false)
    assert.equal(document.nodes.length, count)
    assert.ok(document.nodes.some((node) => node.name === 'wheelContainer'))
    assert.ok(document.nodes.some((node) => node.name === 'wheelCylinder'))
})

test('rewrites only JSON metadata and preserves GLB binary bytes', () =>
{
    const binary = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    const input = writeGlb(createDocument(), [{ type: BIN_CHUNK_TYPE, data: binary }])
    const result = rewriteSU7FourWheelGlb(input)
    const parsed = parseGlb(result.buffer)

    assert.equal(result.changed, true)
    assert.deepEqual(parsed.chunks.find((chunk) => chunk.type === BIN_CHUNK_TYPE).data, binary)
    assert.ok(parsed.document.nodes.some((node) => node.name === 'wheelRearLeftRoll'))
})
