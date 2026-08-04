import assert from 'node:assert/strict'
import test from 'node:test'

import { Quaternion, Vector3 } from 'three'

import {
    DEFAULT_COCKPIT_FORWARD_CORRECTION,
    computeCockpitPose,
    dampCockpitPose,
    dampingAlpha,
} from '../sources/Game/Views/cockpitPose.js'

const closeTo = (actual, expected, epsilon = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not close to ${expected}`)

const vectorCloseTo = (actual, expected, epsilon = 1e-9) =>
{
    closeTo(actual.x, expected.x, epsilon)
    closeTo(actual.y, expected.y, epsilon)
    closeTo(actual.z, expected.z, epsilon)
}

test('computeCockpitPose keeps the local position when the vehicle has no transform', () =>
{
    const pose = computeCockpitPose({
        vehiclePosition: new Vector3(),
        vehicleQuaternion: new Quaternion(),
        localPosition: new Vector3(1, 2, 3),
        forwardCorrection: new Quaternion(),
    })

    vectorCloseTo(pose.position, new Vector3(1, 2, 3))
})

test('computeCockpitPose rotates the driver offset into vehicle world space', () =>
{
    const vehicleQuaternion = new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0),
        Math.PI * 0.5,
    )
    const pose = computeCockpitPose({
        vehiclePosition: new Vector3(10, 0, 20),
        vehicleQuaternion,
        localPosition: new Vector3(1, 0, 0),
        forwardCorrection: new Quaternion(),
    })

    vectorCloseTo(pose.position, new Vector3(10, 0, 19))
})

test('default correction points a Three.js camera toward the vehicle positive X axis', () =>
{
    const pose = computeCockpitPose({
        vehiclePosition: new Vector3(),
        vehicleQuaternion: new Quaternion(),
        localPosition: new Vector3(),
        forwardCorrection: DEFAULT_COCKPIT_FORWARD_CORRECTION,
    })
    const cameraForward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion)

    vectorCloseTo(cameraForward, new Vector3(1, 0, 0))
})

test('computeCockpitPose does not mutate vehicle or head quaternions', () =>
{
    const vehicleQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7)
    const headQuaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2)
    const originalVehicle = vehicleQuaternion.clone()
    const originalHead = headQuaternion.clone()

    computeCockpitPose({
        vehiclePosition: new Vector3(),
        vehicleQuaternion,
        localPosition: new Vector3(),
        headLookQuaternion: headQuaternion,
    })

    assert.ok(vehicleQuaternion.equals(originalVehicle))
    assert.ok(headQuaternion.equals(originalHead))
})

test('dampingAlpha is frame-rate independent and bounded', () =>
{
    closeTo(dampingAlpha(0, 1), 0)
    closeTo(dampingAlpha(10, 0), 0)
    assert.ok(dampingAlpha(10, 1 / 60) > 0)
    assert.ok(dampingAlpha(10, 1 / 60) < 1)
    closeTo(dampingAlpha(10, 1 / 30), 1 - (1 - dampingAlpha(10, 1 / 60)) ** 2)
})

test('dampCockpitPose advances from its persistent pose instead of a reset camera pose', () =>
{
    const position = new Vector3()
    const quaternion = new Quaternion()
    const targetPosition = new Vector3(1, 0, 0)
    const targetQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI * 0.5)
    const halfLifeDamping = Math.log(2)

    dampCockpitPose({
        position,
        quaternion,
        targetPosition,
        targetQuaternion,
        positionDamping: halfLifeDamping,
        rotationDamping: halfLifeDamping,
        delta: 1,
    })
    closeTo(position.x, 0.5)

    dampCockpitPose({
        position,
        quaternion,
        targetPosition,
        targetQuaternion,
        positionDamping: halfLifeDamping,
        rotationDamping: halfLifeDamping,
        delta: 1,
    })
    closeTo(position.x, 0.75)
    closeTo(quaternion.angleTo(targetQuaternion), Math.PI * 0.125)
})
