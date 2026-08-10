const ROOM_PATTERN = /^[a-z0-9_-]{1,64}$/u

export function normalizeRoomName(value)
{
    if(typeof value !== 'string')
        return null

    const normalized = value.trim().toLowerCase()
    return ROOM_PATTERN.test(normalized) ? normalized : null
}
