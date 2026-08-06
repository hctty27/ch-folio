export const RAPIER_VERSION = '0.17.3'

export const VERSIONS = Object.freeze({
    protocolVersion: 2,
    vehiclePhysicsVersion: 1,
    mapCollisionVersion: 1,
})

export function assertCompatibility(remote)
{
    for(const [ key, expected ] of Object.entries(VERSIONS))
    {
        const received = remote?.[key]
        if(received !== expected)
        {
            throw new Error(
                `incompatible ${key}: expected ${expected}, received ${received}`,
            )
        }
    }
}
