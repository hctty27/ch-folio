import assert from 'node:assert/strict'
import test from 'node:test'

import { Euler, Quaternion, Vector3 } from 'three'

import {
    DEFAULT_COCKPIT_FORWARD_CORRECTION,
    DEFAULT_COCKPIT_REST_PITCH,
    DEFAULT_PHYSICAL_COCKPIT_POSITION,
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

test('physical fallback stays between the axles and on the driver side', () =>
{
    assert.ok(DEFAULT_PHYSICAL_COCKPIT_POSITION.x > -0.9)
    assert.ok(DEFAULT_PHYSICAL_COCKPIT_POSITION.x < 0.9)
    assert.ok(DEFAULT_PHYSICAL_COCKPIT_POSITION.y > 0.4)
    assert.ok(DEFAULT_PHYSICAL_COCKPIT_POSITION.y < 0.8)
    assert.ok(DEFAULT_PHYSICAL_COCKPIT_POSITION.z < 0)
    assert.ok(DEFAULT_PHYSICAL_COCKPIT_POSITION.z > -0.75)
})

test('fallback rest pitch looks forward and slightly toward the road', () =>
{
    const headLookQuaternion = new Quaternion().setFromEuler(
        new Euler(DEFAULT_COCKPIT_REST_PITCH, 0, 0, 'YXZ'),
    )
    const pose = computeCockpitPose({
        vehiclePosition: new Vector3(),
        vehicleQuaternion: new Quaternion(),
        localPosition: DEFAULT_PHYSICAL_COCKPIT_POSITION,
        headLookQuaternion,
    })
    const cameraForward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion)

    assert.ok(cameraForward.x > 0.98)
    assert.ok(cameraForward.y < -0.05)
    assert.ok(Math.abs(cameraForward.z) < 1e-9)
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

test('dampCockpitPose keeps independent smoothing state between frames', () =>
{
    const position = new Vector3(0, 0, 0)
    const quaternion = new Quaternion()
    const targetPosition = new Vector3(10, 0, 0)
    const targetQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)

    dampCockpitPose({
        position,
        quaternion,
        targetPosition,
        targetQuaternion,
        positionDamping: 10,
        rotationDamping: 10,
        delta: 1 / 60,
    })
    const firstFrameX = position.x
    const firstFrameAngle = quaternion.angleTo(new Quaternion())

    dampCockpitPose({
        position,
        quaternion,
        targetPosition,
        targetQuaternion,
        positionDamping: 10,
        rotationDamping: 10,
        delta: 1 / 60,
    })

    assert.ok(position.x > firstFrameX)
    assert.ok(position.x < targetPosition.x)
    assert.ok(quaternion.angleTo(new Quaternion()) > firstFrameAngle)
})
