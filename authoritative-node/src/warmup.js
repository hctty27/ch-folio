import mapSource from '../../packages/authoritative-physics/generated/map-v1.json' with { type: 'json' }
import RAPIER from '@dimforge/rapier3d'
import {
    AuthoritativeWorld,
    loadAuthoritativeMap,
} from '@ch-folio/authoritative-physics'

export const AUTHORITATIVE_WARMUP_TICKS = 600
const WARMUP_INPUT_REPEAT_TICKS = 120

const SAFE_INPUT = Object.freeze({
    clientTick: 0,
    sequence: 0,
    throttle: 128,
    brake: 255,
    steering: 0,
    suspensions: 0,
    flags: 0,
})

const ACTIVE_INPUT = Object.freeze({
    throttle: 96,
    brake: 0,
    steering: 0,
    suspensions: 0,
    flags: 0,
})

const WARMUP_ENTITIES = Object.freeze([
    Object.freeze({ entityOrder: 1, position: [ -10, 0.5, -32 ], quaternion: [ 0, 0, 0, 1 ], linearVelocity: [ 16, 0, 0 ], angularVelocity: [ 0, 0, 0 ] }),
    Object.freeze({ entityOrder: 2, position: [ 10, 0.5, -32 ], quaternion: [ 0, 1, 0, 0 ], linearVelocity: [ -16, 0, 0 ], angularVelocity: [ 0, 0, 0 ] }),
    Object.freeze({ entityOrder: 3, position: [ 0, 0.5, -42 ], quaternion: [ 0, -0.707106781, 0, 0.707106781 ], linearVelocity: [ 0, 0, 16 ], angularVelocity: [ 0, 0, 0 ] }),
    Object.freeze({ entityOrder: 4, position: [ 0, 0.5, -22 ], quaternion: [ 0, 0.707106781, 0, 0.707106781 ], linearVelocity: [ 0, 0, -16 ], angularVelocity: [ 0, 0, 0 ] }),
    Object.freeze({ entityOrder: 5, position: [ -8, 0.5, -40 ], quaternion: [ 0, -0.382683, 0, 0.92388 ], linearVelocity: [ 12, 0, 12 ], angularVelocity: [ 0, 0, 0 ] }),
    Object.freeze({ entityOrder: 6, position: [ 8, 0.5, -40 ], quaternion: [ 0, -0.92388, 0, 0.382683 ], linearVelocity: [ -12, 0, 12 ], angularVelocity: [ 0, 0, 0 ] }),
    Object.freeze({ entityOrder: 7, position: [ -8, 0.5, -24 ], quaternion: [ 0, 0.382683, 0, 0.92388 ], linearVelocity: [ 12, 0, -12 ], angularVelocity: [ 0, 0, 0 ] }),
    Object.freeze({ entityOrder: 8, position: [ 8, 0.5, -24 ], quaternion: [ 0, 0.92388, 0, 0.382683 ], linearVelocity: [ -12, 0, -12 ], angularVelocity: [ 0, 0, 0 ] }),
])

function speedOf(velocity)
{
    return Math.sqrt(
        velocity[0] * velocity[0]
        + velocity[1] * velocity[1]
        + velocity[2] * velocity[2]
    )
}

function cloneVector(values)
{
    return [ ...values ]
}

export function runAuthoritativeWarmup({ ticks = AUTHORITATIVE_WARMUP_TICKS } = {})
{
    if(!Number.isSafeInteger(ticks) || ticks < 1)
        throw new TypeError('warmup ticks must be a positive safe integer')

    const mapData = loadAuthoritativeMap(mapSource)
    const world = new AuthoritativeWorld({ RAPIER, mapData })
    let finalTick = 0

    try
    {
        for(const entity of WARMUP_ENTITIES)
        {
            const initial = {
                entityOrder: entity.entityOrder,
                position: cloneVector(entity.position),
                quaternion: cloneVector(entity.quaternion),
                linearVelocity: cloneVector(entity.linearVelocity),
                angularVelocity: cloneVector(entity.angularVelocity),
            }
            world.addVehicle(entity.entityOrder, initial)
            world.setVehicleState(entity.entityOrder, {
                ...initial,
                steering: 0,
                confirmedInputSequence: 0,
                input: SAFE_INPUT,
                previousPosition: cloneVector(entity.position),
                speed: speedOf(entity.linearVelocity),
            })
        }

        for(let tick = 1; tick <= ticks; tick++)
        {
            if((tick - 1) % WARMUP_INPUT_REPEAT_TICKS === 0)
            {
                for(const entity of WARMUP_ENTITIES)
                {
                    world.setInput(entity.entityOrder, {
                        clientTick: tick >>> 0,
                        sequence: tick >>> 0,
                        ...ACTIVE_INPUT,
                    })
                }
            }

            finalTick = world.step()
            if(finalTick !== tick)
                throw new Error(`warmup advanced to unexpected tick ${finalTick}`)
        }
    }
    finally
    {
        world.destroy()
    }

    return {
        ticks,
        finalTick,
        vehicles: WARMUP_ENTITIES.length,
    }
}

export { RAPIER }
