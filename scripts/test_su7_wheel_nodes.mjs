import assert from 'node:assert/strict'
import test from 'node:test'

import {
    SU7_WHEEL_DESCRIPTORS,
    discoverSU7WheelNodes,
} from '../sources/Game/World/SU7WheelNodes.js'

class FakeNode
{
    constructor(name, children = [])
    {
        this.name = name
        this.children = children
    }

    getObjectByName(name)
    {
        if(this.name === name)
            return this

        for(const child of this.children)
        {
            const result = child.getObjectByName(name)
            if(result)
                return result
        }

        return undefined
    }
}

function createWheelTree({ omit = null } = {})
{
    const wheelRoots = SU7_WHEEL_DESCRIPTORS.map((descriptor) =>
    {
        const roll = new FakeNode(descriptor.rollName, [
            new FakeNode(descriptor.paintedName),
        ])
        const brake = new FakeNode(descriptor.brakeName)
        const children = descriptor.steerName
            ? [new FakeNode(descriptor.steerName, [roll, brake])]
            : [roll, brake]
        return new FakeNode(descriptor.rootName, children)
    })

    const root = new FakeNode('chassis', wheelRoots)
    if(omit)
    {
        const remove = (node) =>
        {
            node.children = node.children.filter((child) => child.name !== omit)
            for(const child of node.children)
                remove(child)
        }
        remove(root)
    }
    return root
}

test('discovers SU7 wheel nodes in physical wheel index order', () =>
{
    const result = discoverSU7WheelNodes(createWheelTree())

    assert.equal(result.complete, true)
    assert.equal(result.mode, 'su7-four-wheel')
    assert.deepEqual(result.items.map((item) => item.index), [0, 1, 2, 3])
    assert.deepEqual(
        result.items.map((item) => item.slot),
        ['frontRight', 'frontLeft', 'rearRight', 'rearLeft'],
    )
    assert.equal(result.items[0].steer.name, 'wheelFrontRightSteer')
    assert.equal(result.items[1].steer.name, 'wheelFrontLeftSteer')
    assert.equal(result.items[2].steer, null)
    assert.equal(result.items[3].steer, null)
})

test('falls back atomically when any required SU7 wheel node is missing', () =>
{
    const result = discoverSU7WheelNodes(createWheelTree({ omit: 'wheelRearLeftRoll' }))

    assert.equal(result.complete, false)
    assert.equal(result.mode, 'legacy-template')
    assert.deepEqual(result.items, [])
    assert.ok(result.missing.includes('wheelRearLeftRoll'))
})
