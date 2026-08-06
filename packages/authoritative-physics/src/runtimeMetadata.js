const RECORD_BYTES = 80

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`)
    return value
}

function finite(value, label)
{
    if(!Number.isFinite(value))
        throw new TypeError(`${label} must be finite`)
    return value
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

function input(value)
{
    return {
        clientTick: integer(value?.clientTick, 0, 0xffffffff, 'input.clientTick'),
        sequence: integer(value?.sequence, 0, 0xffffffff, 'input.sequence'),
        throttle: integer(value?.throttle, 0, 0xff, 'input.throttle'),
        brake: integer(value?.brake, 0, 0xff, 'input.brake'),
        steering: integer(value?.steering, -0x8000, 0x7fff, 'input.steering'),
        suspensions: integer(value?.suspensions, 0, 0xff, 'input.suspensions'),
        flags: integer(value?.flags, 0, 0xff, 'input.flags'),
    }
}

function previousPosition(value)
{
    if(!Array.isArray(value) || value.length !== 3)
        throw new TypeError('previousPosition must contain exactly three finite numbers')
    return value.map((component, index) => finite(component, `previousPosition[${index}]`))
}

export const VEHICLE_RUNTIME_METADATA_BYTES = RECORD_BYTES

export function encodeVehicleRuntimeMetadata(value)
{
    const bytes = new Uint8Array(RECORD_BYTES)
    const view = new DataView(bytes.buffer)
    const quantizedInput = input(value?.input)
    const position = previousPosition(value?.previousPosition)

    view.setFloat64(0, finite(value?.bodyHandle, 'bodyHandle'), true)
    view.setUint32(8, quantizedInput.clientTick, true)
    view.setUint32(12, quantizedInput.sequence, true)
    view.setUint8(16, quantizedInput.throttle)
    view.setUint8(17, quantizedInput.brake)
    view.setInt16(18, quantizedInput.steering, true)
    view.setUint8(20, quantizedInput.suspensions)
    view.setUint8(21, quantizedInput.flags)
    view.setFloat64(24, finite(value?.steering, 'steering'), true)
    view.setUint32(32, integer(
        value?.confirmedInputSequence,
        0,
        0xffffffff,
        'confirmedInputSequence',
    ), true)
    view.setFloat64(40, finite(value?.speed, 'speed'), true)
    view.setUint8(48, value?.goingForward === false ? 0 : 1)
    view.setFloat64(56, position[0], true)
    view.setFloat64(64, position[1], true)
    view.setFloat64(72, position[2], true)
    return bytes
}

export function decodeVehicleRuntimeMetadata(value)
{
    const bytes = copyBytes(value, 'vehicle runtime metadata')
    if(bytes.byteLength !== RECORD_BYTES)
    {
        throw new TypeError(
            `vehicle runtime metadata must contain exactly ${RECORD_BYTES} bytes`,
        )
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {
        bodyHandle: view.getFloat64(0, true),
        input: {
            clientTick: view.getUint32(8, true),
            sequence: view.getUint32(12, true),
            throttle: view.getUint8(16),
            brake: view.getUint8(17),
            steering: view.getInt16(18, true),
            suspensions: view.getUint8(20),
            flags: view.getUint8(21),
        },
        steering: view.getFloat64(24, true),
        confirmedInputSequence: view.getUint32(32, true),
        speed: view.getFloat64(40, true),
        goingForward: view.getUint8(48) !== 0,
        previousPosition: [
            view.getFloat64(56, true),
            view.getFloat64(64, true),
            view.getFloat64(72, true),
        ],
    }
}
