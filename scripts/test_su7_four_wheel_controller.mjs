import assert from 'node:assert/strict'
import test from 'node:test'

import { SU7FourWheelController } from '../sources/Game/World/SU7FourWheelController.js'
import { SU7_WHEEL_DESCRIPTORS } from '../sources/Game/World/SU7WheelNodes.js'

class FakeNode
{
    constructor(name, children = [])
    {
        this.name = name
        this.children = children
        this.position = { x: 0, y: -0.5, z: 0 }
        this.rotation = { x: 0, y: 0, z: 0 }
        this.visible = true
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

function createWheelTree()
{
    return new FakeNode('chassis', SU7_WHEEL_DESCRIPTORS.map((descriptor) =>
    {
        const roll = new FakeNode(descriptor.rollName, [new FakeNode(descriptor.paintedName)])
        const brake = new FakeNode(descriptor.brakeName)
        const children = descriptor.steerName
            ? [new FakeNode(descriptor.steerName, [roll, brake])]
            : [roll, brake]
        return new FakeNode(descriptor.rootName, children)
    }))
}

function createGame()
{
    const actions = new Map([
        ['brake', { active: false }],
        ['forward', { active: true }],
        ['backward', { active: false }],
    ])
    const legacyWheels = Array.from({ length: 4 }, () => ({ container: new FakeNode('legacy') }))
    const chassis = createWheelTree()
    return {
        game: {
            ticker: {
                deltaScaled: 0.01,
                events: { on() {}, off() {} },
            },
            world: {
                visualVehicle: {
                    parts: { chassis },
                    wheels: { items: legacyWheels },
                },
            },
            player: { steering: 0.5 },
            inputs: { actions: { get: (name) => actions.get(name) } },
            physicalVehicle: {
                steeringAmplitude: 0.6,
                forwardSpeed: 10,
                wheels: {
                    settings: { radius: 0.4 },
                    items: [
                        { basePosition: { x: 0.9, y: 0, z: 0.75 }, suspensionLength: 0.6 },
                        { basePosition: { x: 0.9, y: 0, z: -0.75 }, suspensionLength: 0.6 },
                        { basePosition: { x: -0.9, y: 0, z: 0.75 }, suspensionLength: 0.6 },
                        { basePosition: { x: -0.9, y: 0, z: -0.75 }, suspensionLength: 0.6 },
                    ],
                },
            },
        },
        chassis,
        legacyWheels,
    }
}

test('hides legacy clones and drives four SU7 wheel roots', () =>
{
    const { game, chassis, legacyWheels } = createGame()
    const controller = new SU7FourWheelController(game)
    controller.update()

    assert.ok(legacyWheels.every((wheel) => wheel.container.visible === false))
    const roots = SU7_WHEEL_DESCRIPTORS.map((descriptor) => chassis.getObjectByName(descriptor.rootName))
    assert.deepEqual(roots.map((root) => root.position.x), [0.9, 0.9, -0.9, -0.9])
    assert.deepEqual(roots.map((root) => root.position.z), [0.75, -0.75, 0.75, -0.75])
    assert.ok(roots.every((root) => root.position.y < -0.5))
})

test('uses the same roll direction for all normalized wheel pivots', () =>
{
    const { game, chassis } = createGame()
    const controller = new SU7FourWheelController(game)
    controller.update()

    const rollAngles = SU7_WHEEL_DESCRIPTORS.map((descriptor) =>
        chassis.getObjectByName(descriptor.rollName).rotation.z)
    assert.ok(rollAngles[0] > 0)
    assert.deepEqual(rollAngles, [rollAngles[0], rollAngles[0], rollAngles[0], rollAngles[0]])
})

test('only front wheels receive steering rotation', () =>
{
    const { game, chassis } = createGame()
    const controller = new SU7FourWheelController(game)
    controller.update()

    assert.ok(chassis.getObjectByName('wheelFrontRightSteer').rotation.y > 0)
    assert.ok(chassis.getObjectByName('wheelFrontLeftSteer').rotation.y > 0)
    assert.equal(chassis.getObjectByName('wheelRearRightRoll').rotation.y, 0)
    assert.equal(chassis.getObjectByName('wheelRearLeftRoll').rotation.y, 0)
})
