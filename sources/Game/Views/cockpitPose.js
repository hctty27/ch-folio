import { Quaternion, Vector3 } from 'three'

const Y_AXIS = new Vector3(0, 1, 0)

export const DEFAULT_COCKPIT_FORWARD_CORRECTION = new Quaternion()
    .setFromAxisAngle(Y_AXIS, - Math.PI * 0.5)

export function dampingAlpha(damping, delta)
{
    const safeDamping = Math.max(0, Number.isFinite(damping) ? damping : 0)
    const safeDelta = Math.max(0, Number.isFinite(delta) ? delta : 0)

    return 1 - Math.exp(- safeDamping * safeDelta)
}

export function computeCockpitPose({
    vehiclePosition,
    vehicleQuaternion,
    localPosition,
    anchorQuaternion = new Quaternion(),
    forwardCorrection = DEFAULT_COCKPIT_FORWARD_CORRECTION,
    headLookQuaternion = new Quaternion(),
})
{
    const position = localPosition
        .clone()
        .applyQuaternion(vehicleQuaternion)
        .add(vehiclePosition)

    const quaternion = vehicleQuaternion
        .clone()
        .multiply(anchorQuaternion)
        .multiply(forwardCorrection)
        .multiply(headLookQuaternion)
        .normalize()

    return { position, quaternion }
}
