import assert from 'node:assert/strict'
import test from 'node:test'

import {
    VEHICLE_CONFIG,
    applyVehicleInput,
    createQuantizedInputFromPlayer,
} from '../src/vehicleConfig.js'

function createControllerRecorder()
{
    const calls = []
    const controller = new Proxy({}, {
        get(_target, property)
        {
            if(property === 'calls')
                return calls

            return (...args) => calls.push([ property, ...args ])
        },
    })

    return controller
}

function findCall(calls, method, wheelIndex)
{
    return calls.find((call) => call[0] === method && call[1] === wheelIndex)
}

test('vehicle tuning freezes the current single-player baseline', () =>
{
    assert.equal(VEHICLE_CONFIG.fixedDt, 1 / 60)
    assert.equal(VEHICLE_CONFIG.controlScale, 1 / 30)
    assert.equal(VEHICLE_CONFIG.steeringAmplitude, 0.5)
    assert.equal(VEHICLE_CONFIG.engineForceAmplitude, 300)
    assert.equal(VEHICLE_CONFIG.boostMultiplier, 2)
    assert.equal(VEHICLE_CONFIG.topSpeed, 5)
    assert.equal(VEHICLE_CONFIG.topSpeedBoost, 40)
    assert.equal(VEHICLE_CONFIG.brakeAmplitude, 35)
    assert.equal(VEHICLE_CONFIG.idleBrake, 0.06)
    assert.equal(VEHICLE_CONFIG.reverseBrake, 0.4)

    assert.deepEqual(VEHICLE_CONFIG.axes, {
        sideward: [ 0, 0, 1 ],
        upward: [ 0, 1, 0 ],
        forward: [ 1, 0, 0 ],
        suspensionDirection: [ 0, -1, 0 ],
        axle: [ 0, 0, 1 ],
    })

    assert.deepEqual(VEHICLE_CONFIG.wheelOrder, [
        'frontRight',
        'frontLeft',
        'rearRight',
        'rearLeft',
    ])
    assert.deepEqual(VEHICLE_CONFIG.wheels.offset, [ 0.90, 0, 0.75 ])
    assert.deepEqual(VEHICLE_CONFIG.wheels.positions, [
        [ 0.90, 0, 0.75 ],
        [ 0.90, 0, -0.75 ],
        [ -0.90, 0, 0.75 ],
        [ -0.90, 0, -0.75 ],
    ])
    assert.equal(VEHICLE_CONFIG.wheels.radius, 0.4)
    assert.equal(VEHICLE_CONFIG.wheels.frictionSlip, 0.9)
    assert.equal(VEHICLE_CONFIG.wheels.maxSuspensionForce, 150)
    assert.equal(VEHICLE_CONFIG.wheels.maxSuspensionTravel, 2)
    assert.equal(VEHICLE_CONFIG.wheels.sideFrictionStiffness, 3)
    assert.equal(VEHICLE_CONFIG.wheels.suspensionCompression, 10)
    assert.equal(VEHICLE_CONFIG.wheels.suspensionRelaxation, 2.7)
    assert.equal(VEHICLE_CONFIG.wheels.suspensionStiffness, 25)

    assert.deepEqual(VEHICLE_CONFIG.suspensions, {
        restLength: { low: 0.88, mid: 1.23, high: 1.63 },
        stiffness: { low: 20, mid: 30, high: 40 },
    })

    assert.deepEqual(VEHICLE_CONFIG.chassis.colliders, [
        {
            shape: 'cuboid',
            mass: 2.5,
            parameters: [ 1.3, 0.4, 0.85 ],
            position: [ 0, -0.1, 0 ],
            centerOfMass: [ 0, -0.5, 0 ],
        },
        {
            shape: 'cuboid',
            mass: 0,
            parameters: [ 0.5, 0.15, 0.65 ],
            position: [ 0, 0.4, 0 ],
        },
        {
            shape: 'cuboid',
            mass: 0,
            parameters: [ 1.5, 0.5, 0.9 ],
            position: [ 0.1, -0.2, 0 ],
            category: 'bumper',
        },
    ])

    assert.equal(VEHICLE_CONFIG.ccdEnabled, true)
    assert.equal(VEHICLE_CONFIG.maxCcdSubsteps, 2)
    assert.equal(VEHICLE_CONFIG.additionalSolverIterations, 2)
    assert.ok(Object.isFrozen(VEHICLE_CONFIG))
    assert.ok(Object.isFrozen(VEHICLE_CONFIG.wheels.positions))
    assert.ok(Object.isFrozen(VEHICLE_CONFIG.chassis.colliders[0]))
})

test('player input is quantized once for prediction and transport', () =>
{
    assert.deepEqual(createQuantizedInputFromPlayer({
        accelerating: -1,
        braking: 0.5,
        steering: 0.5,
        suspensions: [ 'low', 'mid', 'high', 'low' ],
        boosting: 1,
        honking: true,
    }, 12, 34), {
        clientTick: 12,
        sequence: 34,
        throttle: 0,
        brake: 128,
        steering: 16384,
        suspensions: 36,
        flags: 3,
    })
})

test('shared control calculation applies the frozen 60 Hz vehicle contract', () =>
{
    const controller = createControllerRecorder()
    const quantized = createQuantizedInputFromPlayer({
        accelerating: 1,
        braking: 0,
        steering: 0.5,
        suspensions: [ 'low', 'mid', 'high', 'low' ],
        boosting: 1,
        honking: false,
    }, 1, 1)

    const result = applyVehicleInput(controller, {}, quantized, {
        speed: 10,
        goingForward: true,
        frictionSlipByWheel: [ 0.04, 0.9, undefined, 0.2 ],
    })

    assert.equal(result.engineForce, 30)
    assert.equal(result.brake, 0)
    assert.ok(Math.abs(result.steer - (16384 / 32767 * 0.5)) < 1e-12)

    assert.deepEqual(findCall(controller.calls, 'setWheelSteering', 0), [ 'setWheelSteering', 0, result.steer ])
    assert.deepEqual(findCall(controller.calls, 'setWheelSteering', 1), [ 'setWheelSteering', 1, result.steer ])
    assert.deepEqual(findCall(controller.calls, 'setWheelEngineForce', 3), [ 'setWheelEngineForce', 3, 30 ])
    assert.deepEqual(findCall(controller.calls, 'setWheelSuspensionRestLength', 0), [ 'setWheelSuspensionRestLength', 0, 0.88 ])
    assert.deepEqual(findCall(controller.calls, 'setWheelSuspensionRestLength', 1), [ 'setWheelSuspensionRestLength', 1, 1.23 ])
    assert.deepEqual(findCall(controller.calls, 'setWheelSuspensionRestLength', 2), [ 'setWheelSuspensionRestLength', 2, 1.63 ])
    assert.deepEqual(findCall(controller.calls, 'setWheelSuspensionStiffness', 2), [ 'setWheelSuspensionStiffness', 2, 40 ])
    assert.deepEqual(findCall(controller.calls, 'setWheelFrictionSlip', 0), [ 'setWheelFrictionSlip', 0, 0.04 ])
    assert.equal(findCall(controller.calls, 'setWheelFrictionSlip', 2), undefined)
    assert.deepEqual(controller.calls.at(-1), [ 'updateVehicle', 1 / 60 ])
})

test('opposite-direction input becomes deterministic reverse braking', () =>
{
    const controller = createControllerRecorder()
    const quantized = createQuantizedInputFromPlayer({
        accelerating: 1,
        braking: 0,
        steering: 0,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: 0,
        honking: false,
    }, 7, 9)

    const result = applyVehicleInput(controller, {}, quantized, {
        speed: 1,
        goingForward: false,
    })

    assert.equal(result.engineForce, 0)
    assert.equal(result.brake, 0.4 * 35 / 30)
    assert.deepEqual(findCall(controller.calls, 'setWheelBrake', 0), [ 'setWheelBrake', 0, result.brake ])
})
