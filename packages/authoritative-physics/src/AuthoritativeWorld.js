import { quantizeInput } from './input.js'
import { loadAuthoritativeMap } from './map.js'
import {
    createVehicle,
    createVehicleController,
    removeVehicle as removeRapierVehicle,
} from './vehicle.js'
import { VEHICLE_CONFIG } from './vehicleConfig.js'
import { applyVehicleInput } from './vehicleInput.js'

const GRAVITY = Object.freeze({ x: 0, y: -9.81, z: 0 })
const IDENTITY_QUATERNION = Object.freeze([ 0, 0, 0, 1 ])

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

function readVector3(value)
{
    return [ value.x, value.y, value.z ]
}

function readQuaternion(value)
{
    return [ value.x, value.y, value.z, value.w ]
}

function cloneInput(input)
{
    return {
        clientTick: Number(input?.clientTick) >>> 0,
        sequence: Number(input?.sequence) >>> 0,
        throttle: Number(input?.throttle),
        brake: Number(input?.brake),
        steering: Number(input?.steering),
        suspensions: Number(input?.suspensions),
        flags: Number(input?.flags),
    }
}

function createSafeInput()
{
    return quantizeInput({
        clientTick: 0,
        sequence: 0,
        throttle: 0,
        brake: 1,
        steering: 0,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    })
}

function assertEntityOrder(entityOrder)
{
    if(!Number.isInteger(entityOrder) || entityOrder <= 0)
        throw new TypeError('entityOrder must be a positive integer')
}

function assertFiniteVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain exactly ${length} finite numbers`)
}

function createMapColliderDescriptor(RAPIER, collider)
{
    let descriptor

    if(collider.shape === 'cuboid')
    {
        descriptor = RAPIER.ColliderDesc.cuboid(...collider.halfExtents)
            .setTranslation(...collider.center)
            .setRotation(quaternion(collider.quaternion))
    }
    else if(collider.shape === 'trimesh')
    {
        descriptor = RAPIER.ColliderDesc.trimesh(
            new Float32Array(collider.vertices),
            new Uint32Array(collider.indices),
        )
    }
    else
        throw new TypeError(`unsupported map collider shape ${String(collider.shape)}`)

    return descriptor
        .setFriction(collider.friction)
        .setRestitution(collider.restitution)
}

function forwardFromQuaternion(rotation)
{
    return {
        x: 1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
        y: 2 * (rotation.x * rotation.y + rotation.z * rotation.w),
        z: 2 * (rotation.x * rotation.z - rotation.y * rotation.w),
    }
}

function cloneRuntime(vehicle)
{
    return {
        entityOrder: vehicle.entityOrder,
        bodyHandle: vehicle.body.handle,
        input: cloneInput(vehicle.input),
        steering: vehicle.steering,
        confirmedInputSequence: vehicle.confirmedInputSequence,
        speed: vehicle.speed,
        goingForward: vehicle.goingForward,
        previousPosition: [ ...vehicle.previousPosition ],
    }
}

function cloneRuntimeDescriptor(value)
{
    assertEntityOrder(value?.entityOrder)
    if(!Number.isFinite(value?.bodyHandle))
        throw new TypeError('runtime bodyHandle must be finite')
    if(!Number.isFinite(value?.steering))
        throw new TypeError('runtime steering must be finite')
    if(!Number.isFinite(value?.speed))
        throw new TypeError('runtime speed must be finite')
    assertFiniteVector(value?.previousPosition, 3, 'runtime previousPosition')

    return {
        entityOrder: value.entityOrder,
        bodyHandle: value.bodyHandle,
        input: cloneInput(value.input),
        steering: value.steering,
        confirmedInputSequence: Number(value.confirmedInputSequence) >>> 0,
        speed: value.speed,
        goingForward: value.goingForward !== false,
        previousPosition: [ ...value.previousPosition ],
    }
}

export class AuthoritativeWorld
{
    constructor({ RAPIER, mapData })
    {
        if(!RAPIER?.World || !RAPIER?.RigidBodyDesc || !RAPIER?.ColliderDesc)
            throw new TypeError('AuthoritativeWorld requires a Rapier module')

        this.RAPIER = RAPIER
        this.mapData = loadAuthoritativeMap(mapData)
        this.vehicles = new Map()
        this.snapshotMetadata = new WeakMap()
        this.tick = 0
        this.destroyed = false
        this.world = this.createWorld()
    }

    createWorld()
    {
        const world = new this.RAPIER.World(GRAVITY)
        this.configureWorld(world)

        for(const collider of this.mapData.colliders)
            world.createCollider(createMapColliderDescriptor(this.RAPIER, collider))

        return world
    }

    configureWorld(world)
    {
        world.timestep = VEHICLE_CONFIG.fixedDt
        world.integrationParameters.maxCcdSubsteps = VEHICLE_CONFIG.maxCcdSubsteps
        world.integrationParameters.numSolverIterations = 4
        world.integrationParameters.numInternalPgsIterations = 1
    }

    assertActive()
    {
        if(this.destroyed)
            throw new Error('AuthoritativeWorld has been destroyed')
    }

    getVehicle(entityOrder)
    {
        assertEntityOrder(entityOrder)
        const vehicle = this.vehicles.get(entityOrder)
        if(!vehicle)
            throw new Error(`unknown entityOrder ${entityOrder}`)
        return vehicle
    }

    addVehicle(entityOrder, state = {})
    {
        this.assertActive()
        assertEntityOrder(entityOrder)

        if(this.vehicles.has(entityOrder))
            throw new Error(`duplicate entityOrder ${entityOrder}`)

        const position = state.position ?? VEHICLE_CONFIG.spawnPosition
        const initialQuaternion = state.quaternion ?? state.rotation ?? IDENTITY_QUATERNION
        assertFiniteVector(position, 3, 'position')
        assertFiniteVector(initialQuaternion, 4, 'quaternion')

        const physical = createVehicle({
            RAPIER: this.RAPIER,
            world: this.world,
            entityOrder,
            position,
            quaternion: initialQuaternion,
        })

        this.vehicles.set(entityOrder, {
            entityOrder,
            ...physical,
            input: createSafeInput(),
            steering: 0,
            confirmedInputSequence: 0,
            speed: 0,
            goingForward: true,
            previousPosition: [ ...position ],
        })

        return this.readVehicleState(entityOrder)
    }

    removeVehicle(entityOrder)
    {
        this.assertActive()
        assertEntityOrder(entityOrder)

        const vehicle = this.vehicles.get(entityOrder)
        if(!vehicle)
            return false

        removeRapierVehicle(this.world, vehicle)
        this.vehicles.delete(entityOrder)
        return true
    }

    setInput(entityOrder, input)
    {
        this.assertActive()
        const vehicle = this.getVehicle(entityOrder)
        vehicle.input = cloneInput(input)
    }

    step()
    {
        this.assertActive()
        const vehicles = [ ...this.vehicles.values() ]
            .sort((left, right) => left.entityOrder - right.entityOrder)

        for(const vehicle of vehicles)
        {
            const result = applyVehicleInput(
                vehicle.controller,
                vehicle.body,
                vehicle.input,
                {
                    speed: vehicle.speed,
                    goingForward: vehicle.goingForward,
                },
            )

            vehicle.steering = result.steer
            vehicle.confirmedInputSequence = vehicle.input.sequence >>> 0
        }

        this.world.step()

        for(const vehicle of vehicles)
            this.updateRuntime(vehicle)

        this.tick = (this.tick + 1) >>> 0
        return this.tick
    }

    updateRuntime(vehicle)
    {
        const position = vehicle.body.translation()
        const deltaX = position.x - vehicle.previousPosition[0]
        const deltaY = position.y - vehicle.previousPosition[1]
        const deltaZ = position.z - vehicle.previousPosition[2]
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ)

        vehicle.speed = distance / VEHICLE_CONFIG.fixedDt

        if(distance > 0)
        {
            const inverseDistance = 1 / distance
            const forward = forwardFromQuaternion(vehicle.body.rotation())
            const forwardRatio = (
                deltaX * inverseDistance * forward.x +
                deltaY * inverseDistance * forward.y +
                deltaZ * inverseDistance * forward.z
            )
            vehicle.goingForward = forwardRatio > 0.5
        }

        vehicle.previousPosition[0] = position.x
        vehicle.previousPosition[1] = position.y
        vehicle.previousPosition[2] = position.z
    }

    readVehicleState(entityOrder)
    {
        this.assertActive()
        const vehicle = this.getVehicle(entityOrder)

        return {
            entityOrder,
            position: readVector3(vehicle.body.translation()),
            quaternion: readQuaternion(vehicle.body.rotation()),
            linearVelocity: readVector3(vehicle.body.linvel()),
            angularVelocity: readVector3(vehicle.body.angvel()),
            steering: vehicle.steering,
            confirmedInputSequence: vehicle.confirmedInputSequence,
        }
    }

    readVehicleRuntime(entityOrder)
    {
        this.assertActive()
        return cloneRuntime(this.getVehicle(entityOrder))
    }

    setVehicleState(entityOrder, state)
    {
        this.assertActive()
        const vehicle = this.getVehicle(entityOrder)
        const position = state?.position
        const initialQuaternion = state?.quaternion ?? state?.rotation
        const linearVelocity = state?.linearVelocity
        const angularVelocity = state?.angularVelocity

        assertFiniteVector(position, 3, 'position')
        assertFiniteVector(initialQuaternion, 4, 'quaternion')
        assertFiniteVector(linearVelocity, 3, 'linearVelocity')
        assertFiniteVector(angularVelocity, 3, 'angularVelocity')

        vehicle.body.setTranslation(vector3(position), true)
        vehicle.body.setRotation(quaternion(initialQuaternion), true)
        vehicle.body.setLinvel(vector3(linearVelocity), true)
        vehicle.body.setAngvel(vector3(angularVelocity), true)
        vehicle.body.resetForces(true)
        vehicle.body.resetTorques(true)

        vehicle.steering = Number.isFinite(state.steering) ? state.steering : 0
        vehicle.confirmedInputSequence = Number(state.confirmedInputSequence) >>> 0
        vehicle.input = state.input ? cloneInput(state.input) : {
            ...vehicle.input,
            sequence: vehicle.confirmedInputSequence,
        }

        if(state.previousPosition !== undefined)
        {
            assertFiniteVector(state.previousPosition, 3, 'previousPosition')
            vehicle.previousPosition = [ ...state.previousPosition ]
        }
        else
            vehicle.previousPosition = [ ...position ]

        vehicle.speed = Number.isFinite(state.speed)
            ? state.speed
            : Math.sqrt(
                linearVelocity[0] * linearVelocity[0] +
                linearVelocity[1] * linearVelocity[1] +
                linearVelocity[2] * linearVelocity[2]
            )

        if(typeof state.goingForward === 'boolean')
            vehicle.goingForward = state.goingForward
        else
        {
            const forward = forwardFromQuaternion(quaternion(initialQuaternion))
            vehicle.goingForward = (
                linearVelocity[0] * forward.x +
                linearVelocity[1] * forward.y +
                linearVelocity[2] * forward.z
            ) >= 0
        }

        vehicle.controller.setWheelSteering(0, vehicle.steering)
        vehicle.controller.setWheelSteering(1, vehicle.steering)
    }

    takeSnapshot()
    {
        this.assertActive()
        const snapshot = Uint8Array.from(this.world.takeSnapshot())
        this.snapshotMetadata.set(snapshot, {
            tick: this.tick,
            vehicles: [ ...this.vehicles.values() ]
                .sort((left, right) => left.entityOrder - right.entityOrder)
                .map(cloneRuntime),
        })
        return snapshot
    }

    restoreSnapshot(snapshot, explicitMetadata = null)
    {
        this.assertActive()
        if(!(snapshot instanceof Uint8Array))
            throw new TypeError('snapshot must be a Uint8Array')

        const currentMetadata = [ ...this.vehicles.values() ]
            .sort((left, right) => left.entityOrder - right.entityOrder)
            .map(cloneRuntime)
        const capturedMetadata = this.snapshotMetadata.get(snapshot)
        const sourceMetadata = explicitMetadata ?? capturedMetadata ?? {
            tick: this.tick,
            vehicles: currentMetadata,
        }
        if(!Array.isArray(sourceMetadata?.vehicles))
            throw new TypeError('snapshot metadata must contain vehicle runtimes')

        const metadata = {
            tick: Number(sourceMetadata.tick) >>> 0,
            vehicles: sourceMetadata.vehicles
                .map(cloneRuntimeDescriptor)
                .sort((left, right) => left.entityOrder - right.entityOrder),
        }

        const restoredWorld = this.RAPIER.World.restoreSnapshot(snapshot)
        this.configureWorld(restoredWorld)

        const restoredVehicles = new Map()
        for(const descriptor of metadata.vehicles)
        {
            const body = restoredWorld.getRigidBody(descriptor.bodyHandle)
            if(!body)
            {
                restoredWorld.free()
                throw new Error(`snapshot is missing entityOrder ${descriptor.entityOrder}`)
            }

            const controller = createVehicleController(restoredWorld, body)
            controller.setWheelSteering(0, descriptor.steering)
            controller.setWheelSteering(1, descriptor.steering)
            restoredVehicles.set(descriptor.entityOrder, {
                entityOrder: descriptor.entityOrder,
                body,
                controller,
                input: cloneInput(descriptor.input),
                steering: descriptor.steering,
                confirmedInputSequence: descriptor.confirmedInputSequence,
                speed: descriptor.speed,
                goingForward: descriptor.goingForward,
                previousPosition: [ ...descriptor.previousPosition ],
            })
        }

        const previousWorld = this.world
        this.world = restoredWorld
        this.vehicles = restoredVehicles
        this.tick = metadata.tick
        previousWorld.free()
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.destroyed = true
        this.vehicles.clear()
        this.world.free()
    }
}
