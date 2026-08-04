import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { Quaternion, Vector3 } from 'three'

import { CameraModeController } from '../sources/Game/Views/CameraModeController.js'
import {
    CAMERA_MODES,
    CAMERA_MODE_ORDER,
    nextCameraMode,
} from '../sources/Game/Views/cameraModes.js'
import {
    CHASE_CAMERA_SETTINGS,
    CHASE_VIEW_MODE,
    clampChaseDistance,
    computeChasePose,
    createLookQuaternion,
    dampChasePose,
    returnOrbitToRest,
} from '../sources/Game/Views/chasePose.js'

const closeTo = (actual, expected, epsilon = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not close to ${expected}`)

const vectorCloseTo = (actual, expected, epsilon = 1e-9) =>
{
    closeTo(actual.x, expected.x, epsilon)
    closeTo(actual.y, expected.y, epsilon)
    closeTo(actual.z, expected.z, epsilon)
}

test('camera modes cycle default, chase, cockpit, then default', () =>
{
    assert.deepEqual(CAMERA_MODE_ORDER, [
        CAMERA_MODES.DEFAULT,
        CAMERA_MODES.CHASE,
        CAMERA_MODES.COCKPIT,
    ])
    assert.equal(nextCameraMode(CAMERA_MODES.DEFAULT), CAMERA_MODES.CHASE)
    assert.equal(nextCameraMode(CAMERA_MODES.CHASE), CAMERA_MODES.COCKPIT)
    assert.equal(nextCameraMode(CAMERA_MODES.COCKPIT), CAMERA_MODES.DEFAULT)
    assert.equal(nextCameraMode('unknown'), CAMERA_MODES.DEFAULT)
})

test('default chase pose uses the configured overlook pitch', () =>
{
    const pose = computeChasePose({
        vehiclePosition: new Vector3(),
        vehicleQuaternion: new Quaternion(),
        distance: CHASE_CAMERA_SETTINGS.distance,
        height: CHASE_CAMERA_SETTINGS.height,
        lookAhead: CHASE_CAMERA_SETTINGS.lookAhead,
        targetHeight: CHASE_CAMERA_SETTINGS.targetHeight,
    })
    const horizontalDistance = CHASE_CAMERA_SETTINGS.distance
        * Math.cos(CHASE_CAMERA_SETTINGS.overlookPitch)
    const verticalOrbit = CHASE_CAMERA_SETTINGS.distance
        * Math.sin(CHASE_CAMERA_SETTINGS.overlookPitch)

    vectorCloseTo(
        pose.position,
        new Vector3(-horizontalDistance, CHASE_CAMERA_SETTINGS.height + verticalOrbit, 0),
    )
    vectorCloseTo(pose.target, new Vector3(3, 0.9, 0))
})

test('chase pose rotates behind the vehicle in world space', () =>
{
    const vehicleQuaternion = new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0),
        Math.PI * 0.5,
    )
    const pose = computeChasePose({
        vehiclePosition: new Vector3(10, 1, 20),
        vehicleQuaternion,
        distance: 7,
        height: 2.8,
        lookAhead: 3,
        targetHeight: 0.9,
    })
    const horizontalDistance = 7 * Math.cos(CHASE_CAMERA_SETTINGS.overlookPitch)
    const verticalOrbit = 7 * Math.sin(CHASE_CAMERA_SETTINGS.overlookPitch)

    vectorCloseTo(pose.position, new Vector3(10, 3.8 + verticalOrbit, 20 + horizontalDistance))
    vectorCloseTo(pose.target, new Vector3(10, 1.9, 17))
})

test('look quaternion points the camera negative Z axis at its target', () =>
{
    const position = new Vector3(-7, 2.8, 0)
    const target = new Vector3(3, 0.9, 0)
    const quaternion = createLookQuaternion(position, target)
    const cameraForward = new Vector3(0, 0, -1).applyQuaternion(quaternion)
    const expectedForward = target.clone().sub(position).normalize()

    vectorCloseTo(cameraForward, expectedForward)
})

test('chase distance is clamped to configured limits', () =>
{
    closeTo(clampChaseDistance(1), CHASE_CAMERA_SETTINGS.minDistance)
    closeTo(clampChaseDistance(8), 8)
    closeTo(clampChaseDistance(20), CHASE_CAMERA_SETTINGS.maxDistance)
})

test('orbit return moves yaw and pitch toward rest without overshooting', () =>
{
    const first = returnOrbitToRest({
        yaw: 1,
        pitch: 0.5,
        restPitch: 0.1,
        damping: 2.5,
        delta: 1 / 60,
    })

    assert.ok(first.yaw > 0 && first.yaw < 1)
    assert.ok(first.pitch > 0.1 && first.pitch < 0.5)

    const second = returnOrbitToRest({
        yaw: first.yaw,
        pitch: first.pitch,
        restPitch: 0.1,
        damping: 2.5,
        delta: 1 / 60,
    })

    assert.ok(second.yaw < first.yaw)
    assert.ok(second.pitch < first.pitch)
})

test('chase pose damping advances position and rotation independently', () =>
{
    const position = new Vector3()
    const quaternion = new Quaternion()
    const targetPosition = new Vector3(10, 2, 0)
    const targetQuaternion = new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0),
        Math.PI,
    )

    dampChasePose({
        position,
        quaternion,
        targetPosition,
        targetQuaternion,
        positionDamping: 7,
        rotationDamping: 6,
        delta: 1 / 60,
    })

    assert.ok(position.x > 0 && position.x < 10)
    assert.ok(position.y > 0 && position.y < 2)
    assert.ok(quaternion.angleTo(new Quaternion()) > 0)
    assert.ok(quaternion.angleTo(targetQuaternion) > 0)
})

test('chase camera constants match the external view contract', () =>
{
    assert.equal(CHASE_VIEW_MODE, 4)
    assert.deepEqual(CHASE_CAMERA_SETTINGS, {
        fov: 55,
        near: 0.1,
        zoom: 1,
        distance: 7,
        minDistance: 4.5,
        maxDistance: 11,
        height: 2.8,
        overlookPitch: Math.PI / 18,
        lookAhead: 3,
        targetHeight: 0.9,
        positionDamping: 7,
        rotationDamping: 6,
        lookDamping: 12,
        returnSpeed: 2.5,
    })
})

test('controller resolves R3 after the view registers zoomToggle asynchronously', () =>
{
    const actions = new Map()
    const game = {
        inputs: {
            actions,
            addActions(addedActions)
            {
                for(const action of addedActions)
                    actions.set(action.name, { ...action })
            },
            events: { on() {} },
        },
        ticker: { events: { on() {} } },
        view: null,
    }
    const inactiveView = {
        enter: () => true,
        exit: () => false,
    }

    const controller = new CameraModeController(game, {
        chaseView: inactiveView,
        cockpitView: inactiveView,
    })

    const zoomToggle = {
        keys: [ 'Gamepad.r3' ],
        activeKeys: new Set([ 'Gamepad.r3' ]),
        active: true,
        value: 1,
        trigger: 'start',
    }
    actions.set('zoomToggle', zoomToggle)
    game.view = { cinematic: { active: false } }

    controller.update()

    assert.deepEqual(zoomToggle.keys, [])
    assert.equal(zoomToggle.activeKeys.size, 0)
    assert.equal(zoomToggle.active, false)
    assert.equal(zoomToggle.value, 0)
    assert.equal(zoomToggle.trigger, null)
})

test('runtime modules expose one camera toggle owner and explicit view lifecycles', async () =>
{
    const [controllerSource, chaseSource, cockpitSource, indexSource] = await Promise.all([
        readFile(new URL('../sources/Game/Views/CameraModeController.js', import.meta.url), 'utf8'),
        readFile(new URL('../sources/Game/Views/ChaseView.js', import.meta.url), 'utf8'),
        readFile(new URL('../sources/Game/Views/CockpitView.js', import.meta.url), 'utf8'),
        readFile(new URL('../sources/index.js', import.meta.url), 'utf8'),
    ])

    assert.match(controllerSource, /name:\s*['"]cameraToggle['"]/)
    assert.match(controllerSource, /Keyboard\.KeyC/)
    assert.match(controllerSource, /Gamepad\.r3/)
    assert.match(controllerSource, /zoomToggle/)
    assert.match(controllerSource, /key\s*!==\s*['"]Gamepad\.r3['"]/)
    assert.doesNotMatch(cockpitSource, /name:\s*['"]cameraToggle['"]/)
    assert.doesNotMatch(chaseSource, /name:\s*['"]cameraToggle['"]/)

    for(const method of [ 'tryInitialize', 'enter', 'exit', 'update' ])
    {
        assert.match(chaseSource, new RegExp(`\\n\\s*${method}\\(`))
        assert.match(cockpitSource, new RegExp(`\\n\\s*${method}\\(`))
    }

    assert.match(indexSource, /new ChaseView\(game\)/)
    assert.match(indexSource, /new CameraModeController\(game,\s*\{[\s\S]*chaseView,[\s\S]*cockpitView,[\s\S]*\}\)/)
})
