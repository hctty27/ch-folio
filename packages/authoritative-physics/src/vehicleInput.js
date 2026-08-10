import {
    dequantizeInput,
    quantizeInput,
} from './input.js'
import { VEHICLE_CONFIG } from './vehicleConfig.js'

function finiteOr(value, fallback)
{
    return Number.isFinite(value) ? value : fallback
}

function resolveTuning(runtimeState)
{
    return runtimeState?.tuning ?? VEHICLE_CONFIG
}

export function createQuantizedInputFromPlayer(player, tick, sequence)
{
    return quantizeInput({
        clientTick: tick,
        sequence,
        throttle: player?.accelerating,
        brake: player?.braking,
        steering: player?.steering,
        suspensions: player?.suspensions,
        boosting: player?.boosting,
        honking: player?.honking,
    })
}

export function applyVehicleInput(controller, body, quantizedInput, runtimeState = {})
{
    void body

    const tuning = resolveTuning(runtimeState)
    const input = dequantizeInput(quantizedInput)
    const speed = Math.max(0, finiteOr(runtimeState.speed, 0))
    const goingForward = runtimeState.goingForward !== false
    const topSpeed = tuning.topSpeed + (tuning.topSpeedBoost - tuning.topSpeed) * (input.boosting ? 1 : 0)
    const overflowSpeed = Math.max(0, speed - topSpeed)

    let engineForce = (
        input.throttle *
        (1 + (input.boosting ? tuning.boostMultiplier : 0)) *
        tuning.engineForceAmplitude /
        (1 + overflowSpeed) *
        tuning.controlScale
    )

    let brake = input.brake

    if(input.brake === 0 && Math.abs(input.throttle) < 0.1)
        brake = tuning.idleBrake

    if(
        speed > 0.5 &&
        (
            (input.throttle > 0 && !goingForward) ||
            (input.throttle < 0 && goingForward)
        )
    )
    {
        brake = tuning.reverseBrake
        engineForce = 0
    }

    brake *= tuning.brakeAmplitude * tuning.controlScale

    const steer = input.steering * tuning.steeringAmplitude

    controller.setWheelSteering(0, steer)
    controller.setWheelSteering(1, steer)

    for(let wheelIndex = 0; wheelIndex < tuning.wheelOrder.length; wheelIndex++)
    {
        const suspensionState = input.suspensions[wheelIndex]

        controller.setWheelBrake(wheelIndex, brake)
        controller.setWheelEngineForce(wheelIndex, engineForce)
        controller.setWheelSuspensionRestLength(
            wheelIndex,
            tuning.suspensions.restLength[suspensionState],
        )
        controller.setWheelSuspensionStiffness(
            wheelIndex,
            tuning.suspensions.stiffness[suspensionState],
        )

        const frictionSlip = runtimeState.frictionSlipByWheel?.[wheelIndex]
        if(Number.isFinite(frictionSlip))
            controller.setWheelFrictionSlip(wheelIndex, frictionSlip)
    }

    controller.updateVehicle(tuning.fixedDt)

    return {
        engineForce,
        brake,
        steer,
    }
}
