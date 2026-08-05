import { VEHICLE_CONFIG } from './vehicleConfig.js'

const DEFAULT_LINEAR_DAMPING = 0.1
const DEFAULT_ANGULAR_DAMPING = 0.1
const DEFAULT_RESTITUTION = 0.15
const DEFAULT_DENSITY = 0.1

const GROUP_ALL = 0b0000000000000001
const GROUP_OBJECT = 0b0000000000000010
const GROUP_BUMPER = 0b0000000000000100

const COLLISION_GROUPS = Object.freeze({
    object: ((GROUP_ALL | GROUP_OBJECT) << 16) | (GROUP_ALL | GROUP_BUMPER),
    bumper: (GROUP_BUMPER << 16) | GROUP_OBJECT,
})

function vector3(values)
{
    return {
        x: values[0],
        y: values[1],
        z: values[2],
    }
}

function quaternion(values)
{
    return {
        x: values[0],
        y: values[1],
        z: values[2],
        w: values[3],
    }
}

function createChassisColliderDesc(RAPIER, collider)
{
    if(collider.shape !== 'cuboid')
        throw new TypeError(`unsupported vehicle collider shape ${String(collider.shape)}`)

    let descriptor = RAPIER.ColliderDesc.cuboid(...collider.parameters)
        .setTranslation(...collider.position)
        .setDensity(DEFAULT_DENSITY)
        .setFriction(VEHICLE_CONFIG.chassis.friction)
        .setRestitution(DEFAULT_RESTITUTION)
        .setCollisionGroups(COLLISION_GROUPS[collider.category ?? 'object'])

    if(collider.mass !== undefined)
    {
        if(collider.centerOfMass)
        {
            descriptor = descriptor.setMassProperties(
                collider.mass,
                vector3(collider.centerOfMass),
                { x: 1, y: 1, z: 1 },
                { x: 0, y: 0, z: 0, w: 1 },
            )
        }
        else
            descriptor = descriptor.setMass(collider.mass)
    }

    return descriptor
}

export function createVehicleController(world, body)
{
    const controller = world.createVehicleController(body)
    const direction = vector3(VEHICLE_CONFIG.axes.suspensionDirection)
    const axle = vector3(VEHICLE_CONFIG.axes.axle)

    for(const position of VEHICLE_CONFIG.wheels.positions)
    {
        const wheelIndex = controller.addWheel(
            vector3(position),
            direction,
            axle,
            VEHICLE_CONFIG.suspensions.restLength.low,
            VEHICLE_CONFIG.wheels.radius,
        )

        controller.setWheelFrictionSlip(wheelIndex, VEHICLE_CONFIG.wheels.frictionSlip)
        controller.setWheelMaxSuspensionForce(wheelIndex, VEHICLE_CONFIG.wheels.maxSuspensionForce)
        controller.setWheelMaxSuspensionTravel(wheelIndex, VEHICLE_CONFIG.wheels.maxSuspensionTravel)
        controller.setWheelSideFrictionStiffness(wheelIndex, VEHICLE_CONFIG.wheels.sideFrictionStiffness)
        controller.setWheelSuspensionCompression(wheelIndex, VEHICLE_CONFIG.wheels.suspensionCompression)
        controller.setWheelSuspensionRelaxation(wheelIndex, VEHICLE_CONFIG.wheels.suspensionRelaxation)
        controller.setWheelSuspensionStiffness(wheelIndex, VEHICLE_CONFIG.wheels.suspensionStiffness)
    }

    return controller
}

export function createVehicle({
    RAPIER,
    world,
    entityOrder,
    position = VEHICLE_CONFIG.spawnPosition,
    quaternion: initialQuaternion = [ 0, 0, 0, 1 ],
})
{
    const bodyDescriptor = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(...position)
        .setRotation(quaternion(initialQuaternion))
        .setCanSleep(VEHICLE_CONFIG.chassis.canSleep)
        .setLinearDamping(DEFAULT_LINEAR_DAMPING)
        .setAngularDamping(DEFAULT_ANGULAR_DAMPING)

    const body = world.createRigidBody(bodyDescriptor)
    body.enableCcd(VEHICLE_CONFIG.ccdEnabled)
    body.setAdditionalSolverIterations(VEHICLE_CONFIG.additionalSolverIterations)
    body.userData = { entityOrder }

    for(const collider of VEHICLE_CONFIG.chassis.colliders)
        world.createCollider(createChassisColliderDesc(RAPIER, collider), body)

    return {
        body,
        controller: createVehicleController(world, body),
    }
}

export function removeVehicle(world, vehicle)
{
    if(typeof world.removeVehicleController === 'function')
        world.removeVehicleController(vehicle.controller)
    else if(typeof vehicle.controller?.free === 'function')
        vehicle.controller.free()

    world.removeRigidBody(vehicle.body)
}
