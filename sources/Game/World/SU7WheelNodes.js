export const SU7_WHEEL_DESCRIPTORS = Object.freeze([
    Object.freeze({
        index: 0,
        slot: 'frontRight',
        rootName: 'wheelFrontRight',
        steerName: 'wheelFrontRightSteer',
        rollName: 'wheelFrontRightRoll',
        brakeName: 'wheelFrontRightBrake',
        paintedName: 'wheelPainted_frontRight',
    }),
    Object.freeze({
        index: 1,
        slot: 'frontLeft',
        rootName: 'wheelFrontLeft',
        steerName: 'wheelFrontLeftSteer',
        rollName: 'wheelFrontLeftRoll',
        brakeName: 'wheelFrontLeftBrake',
        paintedName: 'wheelPainted_frontLeft',
    }),
    Object.freeze({
        index: 2,
        slot: 'rearRight',
        rootName: 'wheelRearRight',
        steerName: null,
        rollName: 'wheelRearRightRoll',
        brakeName: 'wheelRearRightBrake',
        paintedName: 'wheelPainted_rearRight',
    }),
    Object.freeze({
        index: 3,
        slot: 'rearLeft',
        rootName: 'wheelRearLeft',
        steerName: null,
        rollName: 'wheelRearLeftRoll',
        brakeName: 'wheelRearLeftBrake',
        paintedName: 'wheelPainted_rearLeft',
    }),
])

function getObjectByName(root, name)
{
    if(!root || !name)
        return null

    if(typeof root.getObjectByName === 'function')
        return root.getObjectByName(name) ?? null

    if(root.name === name)
        return root

    for(const child of root.children ?? [])
    {
        const result = getObjectByName(child, name)
        if(result)
            return result
    }

    return null
}

export function discoverSU7WheelNodes(root)
{
    const items = []
    const missing = []

    for(const descriptor of SU7_WHEEL_DESCRIPTORS)
    {
        const container = getObjectByName(root, descriptor.rootName)
        const steer = descriptor.steerName ? getObjectByName(container, descriptor.steerName) : null
        const roll = getObjectByName(container, descriptor.rollName)
        const brake = getObjectByName(container, descriptor.brakeName)
        const painted = getObjectByName(container, descriptor.paintedName)

        if(!container)
            missing.push(descriptor.rootName)
        if(descriptor.steerName && !steer)
            missing.push(descriptor.steerName)
        if(!roll)
            missing.push(descriptor.rollName)
        if(!brake)
            missing.push(descriptor.brakeName)
        if(!painted)
            missing.push(descriptor.paintedName)

        items.push({
            ...descriptor,
            container,
            steer,
            roll,
            brake,
            painted,
        })
    }

    return {
        complete: missing.length === 0,
        mode: missing.length === 0 ? 'su7-four-wheel' : 'legacy-template',
        items: missing.length === 0 ? items : [],
        missing,
    }
}
