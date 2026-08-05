const ROOM_PATTERN = /^[a-z0-9_-]{1,64}$/

export const resolveRoomFromSearch = (search = '') =>
{
    const value = new URLSearchParams(search).get('room')
    if(value === null)
        return null

    const room = value.trim().toLowerCase()
    return ROOM_PATTERN.test(room) ? room : null
}
