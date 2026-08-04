import { Quaternion, Vector3 } from 'three'

import { dampingAlpha } from './cockpitPose.js'

const FORWARD_AXIS = new Vector3(1, 0, 0)
const WORLD_UP = new Vector3(0, 1, 0)

export const CHASE_VIEW_MODE = 4
export const CHASE_CAMERA_SETTINGS = Object.freeze({
    fov: 55,
    near: 0.1,
    zoom: 1,
    distance: 7,
    minDistance: 4.5,
    maxDistance: 11,
    height: 2.8,
    lookAhead: 3,
    targetHeight: 0.9,
    positionDamping: 7,
    rotationDamping: 6,
    lookDamping: 12,
    returnSpeed: 2.5,
})

export function clampChaseDistance(value)
{
    const safeValue = Number.isFinite(value)
        ? value
        : CHASE_CAMERA_SETTINGS.distance

    return Math.min(
        CHASE_CAMERA_SETTINGS.maxDistance,
        Math.max(CHASE_CAMERA_SETTINGS.minDistance, safeValue),
    )
}

export function computeChasePose({
    vehiclePosition,
    vehicleQuaternion,
    distance,
    height,
    lookAhead,
    targetHeight,
    yaw = 0,
    pitch = 0,
})
{
    const forward = FORWARD_AXIS.clone().applyQuaternion(vehicleQuaternion)
    forward.y = 0

    if(forward.lengthSq() < 1e-8)
        forward.copy(FORWARD_AXIS)
    else
        forward.normalize()

    const right = new Vector3(-forward.z, 0, forward.x)
    const horizontalDistance = distance * Math.cos(pitch)
    const verticalOrbit = distance * Math.sin(pitch)

    const position = vehiclePosition
        .clone()
        .addScaledVector(forward, -horizontalDistance * Math.cos(yaw))
        .addScaledVector(right, horizontalDistance * Math.sin(yaw))
        .addScaledVector(WORLD_UP, height + verticalOrbit)

    const target = vehiclePosition
        .clone()
        .addScaledVector(forward, lookAhead)
        .addScaledVector(WORLD_UP, targetHeight)

    return { position, target, forward, right }
}

export function dampChasePose({
    position,
    quaternion,
    targetPosition,
    targetQuaternion,
    positionDamping,
    rotationDamping,
    delta,
})
{
    position.lerp(
        targetPosition,
        dampingAlpha(positionDamping, delta),
    )
    quaternion.slerp(
        targetQuaternion,
        dampingAlpha(rotationDamping, delta),
    ).normalize()

    return { position, quaternion }
}

export function returnOrbitToRest({
    yaw,
    pitch,
    restPitch,
    damping,
    delta,
})
{
    const alpha = dampingAlpha(damping, delta)

    return {
        yaw: yaw + (0 - yaw) * alpha,
        pitch: pitch + (restPitch - pitch) * alpha,
    }
}

export function createLookQuaternion(position, target)
{
    const forward = target.clone().sub(position).normalize()
    const right = new Vector3().crossVectors(forward, WORLD_UP)

    if(right.lengthSq() < 1e-8)
        right.set(0, 0, 1)
    else
        right.normalize()

    const up = new Vector3().crossVectors(right, forward).normalize()
    const matrixElements = [
        right.x, right.y, right.z, 0,
        up.x, up.y, up.z, 0,
        -forward.x, -forward.y, -forward.z, 0,
        0, 0, 0, 1,
    ]

    const quaternion = new Quaternion()
    quaternion.setFromRotationMatrix({ elements: matrixElements })

    return quaternion.normalize()
}
