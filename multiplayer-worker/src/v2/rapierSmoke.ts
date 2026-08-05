export interface RapierSmokeResult
{
    y: number
    snapshotBytes: number
}

type RapierModule = typeof import('@dimforge/rapier3d')

export function runRapierSmoke(RAPIER: RapierModule): RapierSmokeResult
{
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })

    try
    {
        world.timestep = 1 / 60

        const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0),
        )
        world.createCollider(
            RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5),
            body,
        )

        for(let tick = 0; tick < 60; tick++)
            world.step()

        const snapshot = world.takeSnapshot()

        return {
            y: body.translation().y,
            snapshotBytes: snapshot.byteLength,
        }
    }
    finally
    {
        world.free()
    }
}
