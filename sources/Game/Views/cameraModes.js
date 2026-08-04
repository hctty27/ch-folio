export const CAMERA_MODES = Object.freeze({
    DEFAULT: 'default',
    CHASE: 'chase',
    COCKPIT: 'cockpit',
})

export const CAMERA_MODE_ORDER = Object.freeze([
    CAMERA_MODES.DEFAULT,
    CAMERA_MODES.CHASE,
    CAMERA_MODES.COCKPIT,
])

export function nextCameraMode(mode)
{
    const currentIndex = CAMERA_MODE_ORDER.indexOf(mode)

    if(currentIndex === -1)
        return CAMERA_MODES.DEFAULT

    return CAMERA_MODE_ORDER[(currentIndex + 1) % CAMERA_MODE_ORDER.length]
}
