import mapSource from '../generated/map-v1.json' with { type: 'json' }
import {
    AuthoritativeWorld,
    ROOM_SLOT_STATES,
    checksum32,
    hashWorldSnapshot,
    readCanonicalState,
} from '../src/index.js'

const SAMPLE_INTERVAL_TICKS = 3
const HASH_INTERVAL_TICKS = 60
const SAFE_INPUT = Object.freeze({
    clientTick: 0,
    sequence: 0,
    throttle: 0,
    brake: 255,
    steering: 0,
    suspensions: 0,
    flags: 0,
})

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)
    return value
}

function finiteVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite))
        throw new TypeError(`${label} must contain ${length} finite numbers`)
    return [ ...value ]
}

function cloneInput(input)
{
    return {
        clientTick: Number(input.clientTick) >>> 0,
        sequence: Number(input.sequence) >>> 0,
        throttle: Number(input.throttle),
        brake: Number(input.brake),
        steering: Number(input.steering),
        suspensions: Number(input.suspensions),
        flags: Number(input.flags),
    }
}

function normalizeInput(record)
{
    const tick = integer(record?.tick, 1, 0xffffffff, 'input.tick')
    return {
        entityOrder: integer(record?.entityOrder, 1, 8, 'input.entityOrder'),
        input: {
            clientTick: tick,
            sequence: integer(record?.sequence, 0, 0xffffffff, 'input.sequence'),
            throttle: integer(record?.throttle, 0, 255, 'input.throttle'),
            brake: integer(record?.brake, 0, 255, 'input.brake'),
            steering: integer(record?.steering, -32768, 32767, 'input.steering'),
            suspensions: integer(record?.suspensions, 0, 255, 'input.suspensions'),
            flags: integer(record?.flags, 0, 255, 'input.flags'),
        },
    }
}

function normalizeEntity(entity)
{
    return {
        entityOrder: integer(entity?.entityOrder, 1, 8, 'entity.entityOrder'),
        position: finiteVector(entity?.position, 3, 'entity.position'),
        quaternion: finiteVector(entity?.quaternion, 4, 'entity.quaternion'),
        linearVelocity: finiteVector(entity?.linearVelocity ?? [ 0, 0, 0 ], 3, 'entity.linearVelocity'),
        angularVelocity: finiteVector(entity?.angularVelocity ?? [ 0, 0, 0 ], 3, 'entity.angularVelocity'),
    }
}

export function validateScenarioFixture(fixture)
{
    if(!fixture || typeof fixture !== 'object')
        throw new TypeError('fixture must be an object')
    if(typeof fixture.id !== 'string' || !/^[a-z0-9-]+$/.test(fixture.id))
        throw new TypeError('fixture.id must be a lowercase slug')

    const ticks = integer(fixture.ticks, HASH_INTERVAL_TICKS, 0xffff, 'fixture.ticks')
    const entities = fixture.entities.map(normalizeEntity)
        .sort((left, right) => left.entityOrder - right.entityOrder)
    if(entities.length < 1 || entities.length > 8)
        throw new TypeError('fixture must contain one to eight entities')
    if(new Set(entities.map(({ entityOrder }) => entityOrder)).size !== entities.length)
        throw new TypeError('fixture contains duplicate entityOrder')

    const inputs = fixture.inputs.map(normalizeInput)
        .sort((left, right) => left.input.clientTick - right.input.clientTick
            || left.entityOrder - right.entityOrder
            || left.input.sequence - right.input.sequence)
    for(const record of inputs)
    {
        if(record.input.clientTick > ticks)
            throw new TypeError('fixture input tick exceeds fixture duration')
        if(!entities.some(({ entityOrder }) => entityOrder === record.entityOrder))
            throw new TypeError('fixture input references an unknown entity')
    }

    if(!fixture.expected || !Array.isArray(fixture.expected.checksums)
        || !Array.isArray(fixture.expected.snapshotHashes))
        throw new TypeError('fixture.expected must contain checksum and snapshot hash arrays')

    return {
        id: fixture.id,
        ticks,
        entities,
        inputs,
        expected: fixture.expected,
    }
}

function speedOf(velocity)
{
    return Math.sqrt(
        velocity[0] * velocity[0]
        + velocity[1] * velocity[1]
        + velocity[2] * velocity[2]
    )
}

function createCanonicalStates(world, lastInputs)
{
    return readCanonicalState([ ...world.vehicles.keys() ]
        .sort((left, right) => left - right)
        .map((entityOrder) =>
        {
            const state = world.readVehicleState(entityOrder)
            const input = lastInputs.get(entityOrder) ?? SAFE_INPUT
            return {
                entityOrder,
                stateFlags: ROOM_SLOT_STATES.ACTIVE,
                collisionFlags: 0,
                suspensions: input.suspensions,
                lastConfirmedSequence: state.confirmedInputSequence >>> 0,
                position: state.position,
                quaternion: state.quaternion,
                linearVelocity: state.linearVelocity,
                angularVelocity: state.angularVelocity,
                steering: input.steering,
                wheelRotations: [ 0, 0, 0, 0 ],
                controlFlags: 0,
                throttle: input.throttle,
                brake: input.brake,
                inputFlags: input.flags,
            }
        }))
}

export function createAuthoritativeScenarioAdapter({ RAPIER, fixture })
{
    const normalized = validateScenarioFixture(fixture)
    const world = new AuthoritativeWorld({ RAPIER, mapData: mapSource })
    const lastInputs = new Map()

    for(const entity of normalized.entities)
    {
        world.addVehicle(entity.entityOrder, entity)
        world.setVehicleState(entity.entityOrder, {
            ...entity,
            steering: 0,
            confirmedInputSequence: 0,
            input: SAFE_INPUT,
            previousPosition: entity.position,
            speed: speedOf(entity.linearVelocity),
        })
        lastInputs.set(entity.entityOrder, cloneInput(SAFE_INPUT))
    }

    return {
        tick: () => world.tick >>> 0,
        applyInputs(records)
        {
            for(const { entityOrder, input } of records)
            {
                world.setInput(entityOrder, input)
                lastInputs.set(entityOrder, cloneInput(input))
            }
        },
        step: () => world.step(),
        checksum: () => checksum32(createCanonicalStates(world, lastInputs)),
        snapshot: () => world.takeSnapshot(),
        destroy: () => world.destroy(),
    }
}

function groupInputsByTick(inputs)
{
    const grouped = new Map()
    for(const record of inputs)
    {
        const tick = record.input.clientTick
        const bucket = grouped.get(tick) ?? []
        bucket.push(record)
        grouped.set(tick, bucket)
    }
    return grouped
}

function toHex(bytes)
{
    return [ ...bytes ].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function runScenarioWithAdapter({ fixture, adapter })
{
    const normalized = validateScenarioFixture(fixture)
    const inputsByTick = groupInputsByTick(normalized.inputs)
    const checksums = []
    const snapshotHashes = []

    try
    {
        for(let tick = 1; tick <= normalized.ticks; tick++)
        {
            adapter.applyInputs(inputsByTick.get(tick) ?? [])
            const advanced = adapter.step()
            if(advanced !== tick || adapter.tick() !== tick)
                throw new Error(`scenario ${normalized.id} advanced to unexpected tick ${advanced}`)

            if(tick % SAMPLE_INTERVAL_TICKS === 0)
                checksums.push({ tick, checksum32: adapter.checksum() >>> 0 })

            if(tick % HASH_INTERVAL_TICKS === 0)
            {
                const sha256 = await hashWorldSnapshot(adapter.snapshot())
                snapshotHashes.push({ tick, sha256: toHex(sha256) })
            }
        }

        return { checksums, snapshotHashes }
    }
    finally
    {
        adapter.destroy()
    }
}

export function runAuthoritativeScenario({ RAPIER, fixture })
{
    return runScenarioWithAdapter({
        fixture,
        adapter: createAuthoritativeScenarioAdapter({ RAPIER, fixture }),
    })
}
