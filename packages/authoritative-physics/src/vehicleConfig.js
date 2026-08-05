function deepFreeze(value)
{
    if(value === null || typeof value !== 'object' || Object.isFrozen(value))
        return value

    for(const child of Object.values(value))
        deepFreeze(child)

    return Object.freeze(value)
}

export const VEHICLE_CONFIG = deepFreeze({
    fixedDt: 1 / 60,
    controlScale: 1 / 30,
    steeringAmplitude: 0.5,
    engineForceAmplitude: 300,
    boostMultiplier: 2,
    topSpeed: 5,
    topSpeedBoost: 40,
    brakeAmplitude: 35,
    idleBrake: 0.06,
    reverseBrake: 0.4,
    axes: {
        sideward: [ 0, 0, 1 ],
        upward: [ 0, 1, 0 ],
        forward: [ 1, 0, 0 ],
        suspensionDirection: [ 0, -1, 0 ],
        axle: [ 0, 0, 1 ],
    },
    spawnPosition: [ 0, 4, 0 ],
    wheelOrder: [
        'frontRight',
        'frontLeft',
        'rearRight',
        'rearLeft',
    ],
    suspensions: {
        restLength: {
            low: 0.88,
            mid: 1.23,
            high: 1.63,
        },
        stiffness: {
            low: 20,
            mid: 30,
            high: 40,
        },
    },
    wheels: {
        offset: [ 0.90, 0, 0.75 ],
        positions: [
            [ 0.90, 0, 0.75 ],
            [ 0.90, 0, -0.75 ],
            [ -0.90, 0, 0.75 ],
            [ -0.90, 0, -0.75 ],
        ],
        radius: 0.4,
        frictionSlip: 0.9,
        maxSuspensionForce: 150,
        maxSuspensionTravel: 2,
        sideFrictionStiffness: 3,
        suspensionCompression: 10,
        suspensionRelaxation: 2.7,
        suspensionStiffness: 25,
    },
    chassis: {
        friction: 0.4,
        canSleep: false,
        waterGravityMultiplier: 0,
        colliders: [
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
        ],
    },
    ccdEnabled: true,
    maxCcdSubsteps: 2,
    additionalSolverIterations: 2,
})

export {
    applyVehicleInput,
    createQuantizedInputFromPlayer,
} from './vehicleInput.js'
