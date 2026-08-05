const MAX_ENTITIES = 8
const RECORD_BYTES = 76
const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)

    return value
}

function uint8(value, label)
{
    return integer(value, 0, 0xff, label)
}

function uint16(value, label)
{
    return integer(value, 0, 0xffff, label)
}

function uint32(value, label)
{
    return integer(value, 0, 0xffffffff, label)
}

function int16(value, label)
{
    return integer(value, -0x8000, 0x7fff, label)
}

function entityOrder(value, label = 'entityOrder')
{
    return integer(value, 1, MAX_ENTITIES, label)
}

function finiteFloat32(value, label)
{
    if(!Number.isFinite(value))
        throw new TypeError(`${label} must be finite`)

    return Math.fround(value)
}

function float32Vector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length)
        throw new TypeError(`${label} must contain exactly ${length} finite values`)

    return Object.freeze(value.map((component, index) =>
        finiteFloat32(component, `${label}[${index}]`)))
}

function suspensionBits(value, label)
{
    const packed = uint8(value, label)

    for(let wheelIndex = 0; wheelIndex < 4; wheelIndex++)
    {
        if(((packed >>> (wheelIndex * 2)) & 0b11) === 0b11)
            throw new TypeError(`${label} contains an invalid wheel state`)
    }

    return packed
}

function wheelRotations(value)
{
    if(!Array.isArray(value) || value.length !== 4)
        throw new TypeError('wheelRotations must contain exactly four integers')

    return Object.freeze(value.map((rotation, index) =>
        int16(rotation, `wheelRotations[${index}]`)))
}

function canonicalRecord(state)
{
    return Object.freeze({
        entityOrder: entityOrder(state?.entityOrder),
        stateFlags: uint8(state?.stateFlags, 'stateFlags'),
        collisionFlags: uint8(state?.collisionFlags, 'collisionFlags'),
        suspensions: suspensionBits(state?.suspensions, 'suspensions'),
        lastConfirmedSequence: uint32(state?.lastConfirmedSequence, 'lastConfirmedSequence'),
        position: float32Vector(state?.position, 3, 'position'),
        quaternion: float32Vector(state?.quaternion, 4, 'quaternion'),
        linearVelocity: float32Vector(state?.linearVelocity, 3, 'linearVelocity'),
        angularVelocity: float32Vector(state?.angularVelocity, 3, 'angularVelocity'),
        steering: int16(state?.steering, 'steering'),
        wheelRotations: wheelRotations(state?.wheelRotations),
        controlFlags: uint16(state?.controlFlags, 'controlFlags'),
        throttle: uint8(state?.throttle, 'throttle'),
        brake: uint8(state?.brake, 'brake'),
        inputFlags: uint8(state?.inputFlags, 'inputFlags'),
    })
}

export function readCanonicalState(states)
{
    if(!Array.isArray(states) || states.length > MAX_ENTITIES)
        throw new TypeError('canonical state must contain at most eight entities')

    const records = states.map(canonicalRecord)
        .sort((left, right) => left.entityOrder - right.entityOrder)

    for(let index = 1; index < records.length; index++)
    {
        if(records[index - 1].entityOrder === records[index].entityOrder)
            throw new TypeError(`duplicate entityOrder ${records[index].entityOrder}`)
    }

    return Object.freeze(records)
}

function encodeCanonicalState(states)
{
    const records = readCanonicalState(states)
    const bytes = new Uint8Array(records.length * RECORD_BYTES)
    const view = new DataView(bytes.buffer)

    records.forEach((state, recordIndex) =>
    {
        const offset = recordIndex * RECORD_BYTES

        view.setUint8(offset, state.entityOrder)
        view.setUint8(offset + 1, state.stateFlags)
        view.setUint8(offset + 2, state.collisionFlags)
        view.setUint8(offset + 3, state.suspensions)
        view.setUint32(offset + 4, state.lastConfirmedSequence, true)

        state.position.forEach((value, index) =>
            view.setFloat32(offset + 8 + index * 4, value, true))
        state.quaternion.forEach((value, index) =>
            view.setFloat32(offset + 20 + index * 4, value, true))
        state.linearVelocity.forEach((value, index) =>
            view.setFloat32(offset + 36 + index * 4, value, true))
        state.angularVelocity.forEach((value, index) =>
            view.setFloat32(offset + 48 + index * 4, value, true))

        view.setInt16(offset + 60, state.steering, true)
        state.wheelRotations.forEach((value, index) =>
            view.setInt16(offset + 62 + index * 2, value, true))

        view.setUint16(offset + 70, state.controlFlags, true)
        view.setUint8(offset + 72, state.throttle)
        view.setUint8(offset + 73, state.brake)
        view.setUint8(offset + 74, state.inputFlags)
        view.setUint8(offset + 75, 0)
    })

    return bytes
}

export function checksum32(states)
{
    const bytes = encodeCanonicalState(states)
    let hash = FNV_OFFSET_BASIS_32

    for(const byte of bytes)
        hash = Math.imul(hash ^ byte, FNV_PRIME_32) >>> 0

    return hash
}

function copyBytes(value, label)
{
    if(value instanceof Uint8Array)
        return Uint8Array.from(value)

    if(value instanceof ArrayBuffer)
        return new Uint8Array(value.slice(0))

    if(ArrayBuffer.isView(value))
    {
        return Uint8Array.from(new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength,
        ))
    }

    throw new TypeError(`${label} must be binary data`)
}

export function hashWorldSnapshot(snapshot)
{
    const captured = copyBytes(snapshot, 'snapshot')
    const subtle = globalThis.crypto?.subtle

    if(!subtle)
        return Promise.reject(new Error('Web Crypto SubtleCrypto is unavailable'))

    return subtle.digest('SHA-256', captured.buffer)
        .then((digest) => new Uint8Array(digest))
}
