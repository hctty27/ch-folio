import { VERSIONS } from './versions.js'

export const FRAME_HEADER_BYTES = 8
export const INPUT_RECORD_BYTES = 14
export const STATE_RECORD_BYTES = 76

const HELLO_PAYLOAD_BYTES = 8
const RESUME_PAYLOAD_BYTES = 44
const STATE_PREFIX_BYTES = 20
const EVENT_RECORD_BYTES = 12
const WORLD_HASH_BYTES = 36
const FULL_SYNC_PREFIX_BYTES = 32
const ENTITY_DESCRIPTOR_BYTES = 16
const QUEUED_INPUT_BYTES = 15
const ERROR_PREFIX_BYTES = 8

const MAX_ENTITIES = 8
const MAX_INPUT_BATCH = 6
const MAX_EVENTS = 32
const MAX_SYNC_INPUTS = 480
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const MAX_CONTROLLER_METADATA_BYTES = 0xffff

const STATE_HASH_FLAG = 0x80
const STATE_COUNT_MASK = 0x0f
const STATE_RESERVED_FLAGS = 0x70

export const FRAME_TYPES = Object.freeze({
    HELLO: 1,
    RESUME: 2,
    INPUT_BATCH: 3,
    STATE: 4,
    FULL_SYNC: 5,
    ERROR: 6,
})

export class ProtocolError extends Error
{
    constructor(message, cause)
    {
        super(message)
        this.name = 'ProtocolError'
        if(cause !== undefined)
            this.cause = cause
    }
}

function guardedDecode(callback)
{
    try
    {
        return callback()
    }
    catch(error)
    {
        if(error instanceof ProtocolError)
            throw error

        throw new ProtocolError('malformed binary protocol frame', error)
    }
}

function toBytes(value, label = 'frame')
{
    if(value instanceof Uint8Array)
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)

    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

    throw new ProtocolError(`${label} must be binary data`)
}

function copyBytes(value, label, expectedLength, maximumLength)
{
    const source = toBytes(value, label)

    if(expectedLength !== undefined && source.byteLength !== expectedLength)
        throw new ProtocolError(`${label} must contain exactly ${expectedLength} bytes`)

    if(maximumLength !== undefined && source.byteLength > maximumLength)
        throw new ProtocolError(`${label} exceeds ${maximumLength} bytes`)

    return source.slice()
}

function integer(value, minimum, maximum, label)
{
    if(!Number.isInteger(value) || value < minimum || value > maximum)
        throw new ProtocolError(`${label} must be an integer from ${minimum} to ${maximum}`)

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
    return integer(value, 0, MAX_ENTITIES - 1, label)
}

function finiteVector(value, length, label)
{
    if(!Array.isArray(value) || value.length !== length)
        throw new ProtocolError(`${label} must contain exactly ${length} finite values`)

    return value.map((component, index) =>
    {
        if(!Number.isFinite(component))
            throw new ProtocolError(`${label}[${index}] must be finite`)

        return component
    })
}

function suspensionBits(value, label)
{
    const packed = uint8(value, label)

    for(let wheelIndex = 0; wheelIndex < 4; wheelIndex++)
    {
        if(((packed >>> (wheelIndex * 2)) & 0b11) === 0b11)
            throw new ProtocolError(`${label} contains an invalid wheel state`)
    }

    return packed
}

function uniqueEntityOrders(records, label)
{
    const seen = new Set()

    for(const record of records)
    {
        const order = entityOrder(record?.entityOrder, `${label}.entityOrder`)
        if(seen.has(order))
            throw new ProtocolError(`${label} contains duplicate entityOrder ${order}`)

        seen.add(order)
    }
}

function writeHeader(view, frameType, flagsOrCount, payloadByteLength)
{
    view.setUint8(0, uint8(frameType, 'frameType'))
    view.setUint8(1, uint8(flagsOrCount, 'flags/count'))
    view.setUint16(2, VERSIONS.protocolVersion, true)
    view.setUint32(4, uint32(payloadByteLength, 'payloadByteLength'), true)
}

function createFrame(frameType, flagsOrCount, payloadByteLength)
{
    const bytes = new Uint8Array(FRAME_HEADER_BYTES + payloadByteLength)
    writeHeader(new DataView(bytes.buffer), frameType, flagsOrCount, payloadByteLength)
    return bytes
}

function readHeader(input, expectedFrameType)
{
    const bytes = toBytes(input)

    if(bytes.byteLength < FRAME_HEADER_BYTES)
        throw new ProtocolError(`frame is shorter than the ${FRAME_HEADER_BYTES}-byte header`)

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const frameType = view.getUint8(0)
    const flagsOrCount = view.getUint8(1)
    const protocolVersion = view.getUint16(2, true)
    const payloadByteLength = view.getUint32(4, true)

    if(frameType !== expectedFrameType)
        throw new ProtocolError(`unexpected frameType: expected ${expectedFrameType}, received ${frameType}`)

    if(protocolVersion !== VERSIONS.protocolVersion)
        throw new ProtocolError(
            `incompatible protocolVersion: expected ${VERSIONS.protocolVersion}, received ${protocolVersion}`,
        )

    if(payloadByteLength !== bytes.byteLength - FRAME_HEADER_BYTES)
        throw new ProtocolError(
            `payload length mismatch: header ${payloadByteLength}, actual ${bytes.byteLength - FRAME_HEADER_BYTES}`,
        )

    return {
        bytes,
        view,
        frameType,
        flagsOrCount,
        protocolVersion,
        payloadByteLength,
        payloadOffset: FRAME_HEADER_BYTES,
    }
}

function assertVersions(vehiclePhysicsVersion, mapCollisionVersion)
{
    if(vehiclePhysicsVersion !== VERSIONS.vehiclePhysicsVersion)
        throw new ProtocolError(
            `incompatible vehiclePhysicsVersion: expected ${VERSIONS.vehiclePhysicsVersion}, received ${vehiclePhysicsVersion}`,
        )

    if(mapCollisionVersion !== VERSIONS.mapCollisionVersion)
        throw new ProtocolError(
            `incompatible mapCollisionVersion: expected ${VERSIONS.mapCollisionVersion}, received ${mapCollisionVersion}`,
        )
}

function writeInputRecord(view, offset, input)
{
    view.setUint32(offset, uint32(input?.clientTick, 'input.clientTick'), true)
    view.setUint32(offset + 4, uint32(input?.sequence, 'input.sequence'), true)
    view.setUint8(offset + 8, uint8(input?.throttle, 'input.throttle'))
    view.setUint8(offset + 9, uint8(input?.brake, 'input.brake'))
    view.setInt16(offset + 10, int16(input?.steering, 'input.steering'), true)
    view.setUint8(offset + 12, suspensionBits(input?.suspensions, 'input.suspensions'))
    view.setUint8(offset + 13, uint8(input?.flags, 'input.flags'))
}

function readInputRecord(view, offset)
{
    return {
        clientTick: view.getUint32(offset, true),
        sequence: view.getUint32(offset + 4, true),
        throttle: view.getUint8(offset + 8),
        brake: view.getUint8(offset + 9),
        steering: view.getInt16(offset + 10, true),
        suspensions: suspensionBits(view.getUint8(offset + 12), 'input.suspensions'),
        flags: view.getUint8(offset + 13),
    }
}

export function encodeHello({ clientTick })
{
    const bytes = createFrame(FRAME_TYPES.HELLO, 0, HELLO_PAYLOAD_BYTES)
    const view = new DataView(bytes.buffer)
    const offset = FRAME_HEADER_BYTES

    view.setUint16(offset, VERSIONS.vehiclePhysicsVersion, true)
    view.setUint16(offset + 2, VERSIONS.mapCollisionVersion, true)
    view.setUint32(offset + 4, uint32(clientTick, 'clientTick'), true)
    return bytes
}

export function decodeHello(input)
{
    return guardedDecode(() =>
    {
        const frame = readHeader(input, FRAME_TYPES.HELLO)
        if(frame.flagsOrCount !== 0 || frame.payloadByteLength !== HELLO_PAYLOAD_BYTES)
            throw new ProtocolError('invalid hello frame layout')

        const offset = frame.payloadOffset
        const vehiclePhysicsVersion = frame.view.getUint16(offset, true)
        const mapCollisionVersion = frame.view.getUint16(offset + 2, true)
        assertVersions(vehiclePhysicsVersion, mapCollisionVersion)

        return {
            protocolVersion: frame.protocolVersion,
            vehiclePhysicsVersion,
            mapCollisionVersion,
            clientTick: frame.view.getUint32(offset + 4, true),
        }
    })
}

export function encodeResume({ playerId, lastServerTick, resumeToken })
{
    const token = copyBytes(resumeToken, 'resumeToken', 32)
    const bytes = createFrame(FRAME_TYPES.RESUME, 0, RESUME_PAYLOAD_BYTES)
    const view = new DataView(bytes.buffer)
    const offset = FRAME_HEADER_BYTES

    view.setUint16(offset, VERSIONS.vehiclePhysicsVersion, true)
    view.setUint16(offset + 2, VERSIONS.mapCollisionVersion, true)
    view.setUint32(offset + 4, uint32(playerId, 'playerId'), true)
    view.setUint32(offset + 8, uint32(lastServerTick, 'lastServerTick'), true)
    bytes.set(token, offset + 12)
    return bytes
}

export function decodeResume(input)
{
    return guardedDecode(() =>
    {
        const frame = readHeader(input, FRAME_TYPES.RESUME)
        if(frame.flagsOrCount !== 0 || frame.payloadByteLength !== RESUME_PAYLOAD_BYTES)
            throw new ProtocolError('invalid resume frame layout')

        const offset = frame.payloadOffset
        const vehiclePhysicsVersion = frame.view.getUint16(offset, true)
        const mapCollisionVersion = frame.view.getUint16(offset + 2, true)
        assertVersions(vehiclePhysicsVersion, mapCollisionVersion)

        return {
            protocolVersion: frame.protocolVersion,
            vehiclePhysicsVersion,
            mapCollisionVersion,
            playerId: frame.view.getUint32(offset + 4, true),
            lastServerTick: frame.view.getUint32(offset + 8, true),
            resumeToken: frame.bytes.slice(offset + 12, offset + 44),
        }
    })
}

export function encodeInputBatch(inputs)
{
    if(!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_INPUT_BATCH)
        throw new ProtocolError('input batch must contain between one and six records')

    const payloadByteLength = inputs.length * INPUT_RECORD_BYTES
    const bytes = createFrame(FRAME_TYPES.INPUT_BATCH, inputs.length, payloadByteLength)
    const view = new DataView(bytes.buffer)

    inputs.forEach((input, index) =>
    {
        writeInputRecord(view, FRAME_HEADER_BYTES + index * INPUT_RECORD_BYTES, input)
    })

    return bytes
}

export function decodeInputBatch(input)
{
    return guardedDecode(() =>
    {
        const frame = readHeader(input, FRAME_TYPES.INPUT_BATCH)
        const count = frame.flagsOrCount

        if(count < 1 || count > MAX_INPUT_BATCH)
            throw new ProtocolError('input batch must contain between one and six records')

        if(frame.payloadByteLength !== count * INPUT_RECORD_BYTES)
            throw new ProtocolError('input batch payload length does not match its record count')

        return Array.from({ length: count }, (_, index) =>
            readInputRecord(frame.view, frame.payloadOffset + index * INPUT_RECORD_BYTES))
    })
}

function writeStateRecord(view, offset, state)
{
    view.setUint8(offset, entityOrder(state?.entityOrder, 'state.entityOrder'))
    view.setUint8(offset + 1, uint8(state?.stateFlags, 'state.stateFlags'))
    view.setUint8(offset + 2, uint8(state?.collisionFlags, 'state.collisionFlags'))
    view.setUint8(offset + 3, suspensionBits(state?.suspensions, 'state.suspensions'))
    view.setUint32(offset + 4, uint32(state?.lastConfirmedSequence, 'state.lastConfirmedSequence'), true)

    const position = finiteVector(state?.position, 3, 'state.position')
    const quaternion = finiteVector(state?.quaternion, 4, 'state.quaternion')
    const linearVelocity = finiteVector(state?.linearVelocity, 3, 'state.linearVelocity')
    const angularVelocity = finiteVector(state?.angularVelocity, 3, 'state.angularVelocity')

    position.forEach((value, index) => view.setFloat32(offset + 8 + index * 4, value, true))
    quaternion.forEach((value, index) => view.setFloat32(offset + 20 + index * 4, value, true))
    linearVelocity.forEach((value, index) => view.setFloat32(offset + 36 + index * 4, value, true))
    angularVelocity.forEach((value, index) => view.setFloat32(offset + 48 + index * 4, value, true))

    view.setInt16(offset + 60, int16(state?.steering, 'state.steering'), true)

    if(!Array.isArray(state?.wheelRotations) || state.wheelRotations.length !== 4)
        throw new ProtocolError('state.wheelRotations must contain exactly four integers')

    state.wheelRotations.forEach((value, index) =>
        view.setInt16(offset + 62 + index * 2, int16(value, `state.wheelRotations[${index}]`), true))

    view.setUint16(offset + 70, uint16(state?.controlFlags, 'state.controlFlags'), true)
    view.setUint8(offset + 72, uint8(state?.throttle, 'state.throttle'))
    view.setUint8(offset + 73, uint8(state?.brake, 'state.brake'))
    view.setUint8(offset + 74, uint8(state?.inputFlags, 'state.inputFlags'))
    view.setUint8(offset + 75, 0)
}

function readFiniteFloat32(view, offset, label)
{
    const value = view.getFloat32(offset, true)
    if(!Number.isFinite(value))
        throw new ProtocolError(`${label} must be finite`)
    return value
}

function readStateRecord(view, offset)
{
    const position = Array.from({ length: 3 }, (_, index) =>
        readFiniteFloat32(view, offset + 8 + index * 4, `state.position[${index}]`))
    const quaternion = Array.from({ length: 4 }, (_, index) =>
        readFiniteFloat32(view, offset + 20 + index * 4, `state.quaternion[${index}]`))
    const linearVelocity = Array.from({ length: 3 }, (_, index) =>
        readFiniteFloat32(view, offset + 36 + index * 4, `state.linearVelocity[${index}]`))
    const angularVelocity = Array.from({ length: 3 }, (_, index) =>
        readFiniteFloat32(view, offset + 48 + index * 4, `state.angularVelocity[${index}]`))

    return {
        entityOrder: entityOrder(view.getUint8(offset), 'state.entityOrder'),
        stateFlags: view.getUint8(offset + 1),
        collisionFlags: view.getUint8(offset + 2),
        suspensions: suspensionBits(view.getUint8(offset + 3), 'state.suspensions'),
        lastConfirmedSequence: view.getUint32(offset + 4, true),
        position,
        quaternion,
        linearVelocity,
        angularVelocity,
        steering: view.getInt16(offset + 60, true),
        wheelRotations: Array.from({ length: 4 }, (_, index) => view.getInt16(offset + 62 + index * 2, true)),
        controlFlags: view.getUint16(offset + 70, true),
        throttle: view.getUint8(offset + 72),
        brake: view.getUint8(offset + 73),
        inputFlags: view.getUint8(offset + 74),
    }
}

function writeEventRecord(view, offset, event)
{
    view.setUint8(offset, uint8(event?.type, 'event.type'))
    view.setUint8(offset + 1, entityOrder(event?.entityOrder, 'event.entityOrder'))
    view.setUint8(offset + 2, uint8(event?.spawnIndex, 'event.spawnIndex'))
    view.setUint8(offset + 3, uint8(event?.flags, 'event.flags'))
    view.setUint32(offset + 4, uint32(event?.tick, 'event.tick'), true)
    view.setUint32(offset + 8, uint32(event?.value, 'event.value'), true)
}

function readEventRecord(view, offset)
{
    return {
        type: view.getUint8(offset),
        entityOrder: entityOrder(view.getUint8(offset + 1), 'event.entityOrder'),
        spawnIndex: view.getUint8(offset + 2),
        flags: view.getUint8(offset + 3),
        tick: view.getUint32(offset + 4, true),
        value: view.getUint32(offset + 8, true),
    }
}

export function encodeStateFrame({
    serverTick,
    eventCursor,
    checksum32,
    states,
    events = [],
    worldHash = null,
})
{
    if(!Array.isArray(states) || states.length > MAX_ENTITIES)
        throw new ProtocolError('state frame cannot contain more than eight entities')

    if(!Array.isArray(events) || events.length > MAX_EVENTS)
        throw new ProtocolError(`state frame cannot contain more than ${MAX_EVENTS} events`)

    uniqueEntityOrders(states, 'states')

    const hashBytes = worldHash === null
        ? null
        : copyBytes(worldHash?.sha256, 'worldHash.sha256', 32)
    const payloadByteLength = STATE_PREFIX_BYTES
        + states.length * STATE_RECORD_BYTES
        + events.length * EVENT_RECORD_BYTES
        + (hashBytes === null ? 0 : WORLD_HASH_BYTES)
    const flagsOrCount = states.length | (hashBytes === null ? 0 : STATE_HASH_FLAG)
    const bytes = createFrame(FRAME_TYPES.STATE, flagsOrCount, payloadByteLength)
    const view = new DataView(bytes.buffer)
    const prefix = FRAME_HEADER_BYTES

    view.setUint32(prefix, uint32(serverTick, 'serverTick'), true)
    view.setUint32(prefix + 4, uint32(eventCursor, 'eventCursor'), true)
    view.setUint32(prefix + 8, uint32(checksum32, 'checksum32'), true)
    view.setUint16(prefix + 12, VERSIONS.vehiclePhysicsVersion, true)
    view.setUint16(prefix + 14, VERSIONS.mapCollisionVersion, true)
    view.setUint8(prefix + 16, events.length)
    view.setUint8(prefix + 17, 0)
    view.setUint16(prefix + 18, STATE_RECORD_BYTES, true)

    let offset = prefix + STATE_PREFIX_BYTES
    for(const state of states)
    {
        writeStateRecord(view, offset, state)
        offset += STATE_RECORD_BYTES
    }

    for(const event of events)
    {
        writeEventRecord(view, offset, event)
        offset += EVENT_RECORD_BYTES
    }

    if(hashBytes !== null)
    {
        view.setUint32(offset, uint32(worldHash?.hashTick, 'worldHash.hashTick'), true)
        bytes.set(hashBytes, offset + 4)
    }

    return bytes
}

export function decodeStateFrame(input)
{
    return guardedDecode(() =>
    {
        const frame = readHeader(input, FRAME_TYPES.STATE)
        if((frame.flagsOrCount & STATE_RESERVED_FLAGS) !== 0)
            throw new ProtocolError('state frame contains reserved flags')

        const entityCount = frame.flagsOrCount & STATE_COUNT_MASK
        const hasWorldHash = (frame.flagsOrCount & STATE_HASH_FLAG) !== 0
        if(entityCount > MAX_ENTITIES)
            throw new ProtocolError('state frame cannot contain more than eight entities')

        if(frame.payloadByteLength < STATE_PREFIX_BYTES)
            throw new ProtocolError('state frame payload is shorter than its prefix')

        const prefix = frame.payloadOffset
        const vehiclePhysicsVersion = frame.view.getUint16(prefix + 12, true)
        const mapCollisionVersion = frame.view.getUint16(prefix + 14, true)
        assertVersions(vehiclePhysicsVersion, mapCollisionVersion)

        const eventCount = frame.view.getUint8(prefix + 16)
        if(eventCount > MAX_EVENTS)
            throw new ProtocolError(`state frame cannot contain more than ${MAX_EVENTS} events`)

        if(frame.view.getUint8(prefix + 17) !== 0)
            throw new ProtocolError('state frame reserved byte must be zero')

        if(frame.view.getUint16(prefix + 18, true) !== STATE_RECORD_BYTES)
            throw new ProtocolError('unsupported state record size')

        const expectedPayload = STATE_PREFIX_BYTES
            + entityCount * STATE_RECORD_BYTES
            + eventCount * EVENT_RECORD_BYTES
            + (hasWorldHash ? WORLD_HASH_BYTES : 0)
        if(frame.payloadByteLength !== expectedPayload)
            throw new ProtocolError('state frame payload length does not match its counts')

        let offset = prefix + STATE_PREFIX_BYTES
        const states = Array.from({ length: entityCount }, () =>
        {
            const state = readStateRecord(frame.view, offset)
            offset += STATE_RECORD_BYTES
            return state
        })
        uniqueEntityOrders(states, 'states')

        const events = Array.from({ length: eventCount }, () =>
        {
            const event = readEventRecord(frame.view, offset)
            offset += EVENT_RECORD_BYTES
            return event
        })

        let worldHash = null
        if(hasWorldHash)
        {
            worldHash = {
                hashTick: frame.view.getUint32(offset, true),
                sha256: frame.bytes.slice(offset + 4, offset + WORLD_HASH_BYTES),
            }
        }

        return {
            protocolVersion: frame.protocolVersion,
            vehiclePhysicsVersion,
            mapCollisionVersion,
            serverTick: frame.view.getUint32(prefix, true),
            eventCursor: frame.view.getUint32(prefix + 4, true),
            checksum32: frame.view.getUint32(prefix + 8, true),
            states,
            events,
            worldHash,
        }
    })
}

function validateEntityDescriptors(entities, metadataLength)
{
    if(!Array.isArray(entities) || entities.length > MAX_ENTITIES)
        throw new ProtocolError('full sync cannot contain more than eight entities')

    uniqueEntityOrders(entities, 'entities')

    for(const entity of entities)
    {
        entityOrder(entity?.entityOrder, 'entity.entityOrder')
        uint8(entity?.slotState, 'entity.slotState')
        uint8(entity?.spawnIndex, 'entity.spawnIndex')
        uint8(entity?.flags, 'entity.flags')
        uint32(entity?.playerId, 'entity.playerId')
        uint32(entity?.lastConfirmedSequence, 'entity.lastConfirmedSequence')
        const offset = uint16(entity?.controllerOffset, 'entity.controllerOffset')
        const length = uint16(entity?.controllerLength, 'entity.controllerLength')
        if(offset + length > metadataLength)
            throw new ProtocolError('entity controller metadata range exceeds the controller metadata block')
    }
}

function writeEntityDescriptor(view, offset, entity)
{
    view.setUint8(offset, entity.entityOrder)
    view.setUint8(offset + 1, entity.slotState)
    view.setUint8(offset + 2, entity.spawnIndex)
    view.setUint8(offset + 3, entity.flags)
    view.setUint32(offset + 4, entity.playerId, true)
    view.setUint32(offset + 8, entity.lastConfirmedSequence, true)
    view.setUint16(offset + 12, entity.controllerOffset, true)
    view.setUint16(offset + 14, entity.controllerLength, true)
}

function readEntityDescriptor(view, offset)
{
    return {
        entityOrder: entityOrder(view.getUint8(offset), 'entity.entityOrder'),
        slotState: view.getUint8(offset + 1),
        spawnIndex: view.getUint8(offset + 2),
        flags: view.getUint8(offset + 3),
        playerId: view.getUint32(offset + 4, true),
        lastConfirmedSequence: view.getUint32(offset + 8, true),
        controllerOffset: view.getUint16(offset + 12, true),
        controllerLength: view.getUint16(offset + 14, true),
    }
}

export function encodeFullSyncFrame({
    checkpointTick,
    serverTick,
    eventCursor,
    checksum32,
    snapshot,
    entities,
    controllerMetadata,
    queuedInputs,
})
{
    const snapshotBytes = copyBytes(snapshot, 'snapshot', undefined, MAX_SNAPSHOT_BYTES)
    const metadataBytes = copyBytes(
        controllerMetadata,
        'controllerMetadata',
        undefined,
        MAX_CONTROLLER_METADATA_BYTES,
    )
    validateEntityDescriptors(entities, metadataBytes.byteLength)

    if(!Array.isArray(queuedInputs) || queuedInputs.length > MAX_SYNC_INPUTS)
        throw new ProtocolError(`full sync cannot contain more than ${MAX_SYNC_INPUTS} queued inputs`)

    const payloadByteLength = FULL_SYNC_PREFIX_BYTES
        + snapshotBytes.byteLength
        + entities.length * ENTITY_DESCRIPTOR_BYTES
        + metadataBytes.byteLength
        + queuedInputs.length * QUEUED_INPUT_BYTES
    const bytes = createFrame(FRAME_TYPES.FULL_SYNC, entities.length, payloadByteLength)
    const view = new DataView(bytes.buffer)
    const prefix = FRAME_HEADER_BYTES

    view.setUint32(prefix, uint32(checkpointTick, 'checkpointTick'), true)
    view.setUint32(prefix + 4, uint32(serverTick, 'serverTick'), true)
    view.setUint32(prefix + 8, uint32(eventCursor, 'eventCursor'), true)
    view.setUint32(prefix + 12, uint32(checksum32, 'checksum32'), true)
    view.setUint16(prefix + 16, VERSIONS.vehiclePhysicsVersion, true)
    view.setUint16(prefix + 18, VERSIONS.mapCollisionVersion, true)
    view.setUint8(prefix + 20, entities.length)
    view.setUint8(prefix + 21, 0)
    view.setUint16(prefix + 22, queuedInputs.length, true)
    view.setUint32(prefix + 24, snapshotBytes.byteLength, true)
    view.setUint32(prefix + 28, metadataBytes.byteLength, true)

    let offset = prefix + FULL_SYNC_PREFIX_BYTES
    bytes.set(snapshotBytes, offset)
    offset += snapshotBytes.byteLength

    for(const entity of entities)
    {
        writeEntityDescriptor(view, offset, entity)
        offset += ENTITY_DESCRIPTOR_BYTES
    }

    bytes.set(metadataBytes, offset)
    offset += metadataBytes.byteLength

    for(const queued of queuedInputs)
    {
        view.setUint8(offset, entityOrder(queued?.entityOrder, 'queuedInput.entityOrder'))
        writeInputRecord(view, offset + 1, queued?.input)
        offset += QUEUED_INPUT_BYTES
    }

    return bytes
}

export function decodeFullSyncFrame(input)
{
    return guardedDecode(() =>
    {
        const frame = readHeader(input, FRAME_TYPES.FULL_SYNC)
        const entityCount = frame.flagsOrCount
        if(entityCount > MAX_ENTITIES)
            throw new ProtocolError('full sync cannot contain more than eight entities')

        if(frame.payloadByteLength < FULL_SYNC_PREFIX_BYTES)
            throw new ProtocolError('full sync payload is shorter than its prefix')

        const prefix = frame.payloadOffset
        const vehiclePhysicsVersion = frame.view.getUint16(prefix + 16, true)
        const mapCollisionVersion = frame.view.getUint16(prefix + 18, true)
        assertVersions(vehiclePhysicsVersion, mapCollisionVersion)

        const descriptorCount = frame.view.getUint8(prefix + 20)
        if(descriptorCount !== entityCount)
            throw new ProtocolError('full sync header entity count does not match its descriptor count')

        if(frame.view.getUint8(prefix + 21) !== 0)
            throw new ProtocolError('full sync reserved byte must be zero')

        const queuedInputCount = frame.view.getUint16(prefix + 22, true)
        if(queuedInputCount > MAX_SYNC_INPUTS)
            throw new ProtocolError(`full sync cannot contain more than ${MAX_SYNC_INPUTS} queued inputs`)

        const snapshotLength = frame.view.getUint32(prefix + 24, true)
        const metadataLength = frame.view.getUint32(prefix + 28, true)
        if(snapshotLength > MAX_SNAPSHOT_BYTES)
            throw new ProtocolError('full sync snapshot exceeds the maximum size')
        if(metadataLength > MAX_CONTROLLER_METADATA_BYTES)
            throw new ProtocolError('full sync controller metadata exceeds the maximum size')

        const expectedPayload = FULL_SYNC_PREFIX_BYTES
            + snapshotLength
            + descriptorCount * ENTITY_DESCRIPTOR_BYTES
            + metadataLength
            + queuedInputCount * QUEUED_INPUT_BYTES
        if(frame.payloadByteLength !== expectedPayload)
            throw new ProtocolError('full sync payload length does not match its declared blocks')

        let offset = prefix + FULL_SYNC_PREFIX_BYTES
        const snapshot = frame.bytes.slice(offset, offset + snapshotLength)
        offset += snapshotLength

        const entities = Array.from({ length: descriptorCount }, () =>
        {
            const entity = readEntityDescriptor(frame.view, offset)
            offset += ENTITY_DESCRIPTOR_BYTES
            return entity
        })
        uniqueEntityOrders(entities, 'entities')

        const controllerMetadata = frame.bytes.slice(offset, offset + metadataLength)
        offset += metadataLength
        validateEntityDescriptors(entities, controllerMetadata.byteLength)

        const queuedInputs = Array.from({ length: queuedInputCount }, () =>
        {
            const queued = {
                entityOrder: entityOrder(frame.view.getUint8(offset), 'queuedInput.entityOrder'),
                input: readInputRecord(frame.view, offset + 1),
            }
            offset += QUEUED_INPUT_BYTES
            return queued
        })

        return {
            protocolVersion: frame.protocolVersion,
            vehiclePhysicsVersion,
            mapCollisionVersion,
            checkpointTick: frame.view.getUint32(prefix, true),
            serverTick: frame.view.getUint32(prefix + 4, true),
            eventCursor: frame.view.getUint32(prefix + 8, true),
            checksum32: frame.view.getUint32(prefix + 12, true),
            snapshot,
            entities,
            controllerMetadata,
            queuedInputs,
        }
    })
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export function encodeErrorFrame({ code, retryable = false, contextTick, message })
{
    const messageBytes = textEncoder.encode(String(message ?? ''))
    if(messageBytes.byteLength > 0xffff)
        throw new ProtocolError('error message exceeds 65535 UTF-8 bytes')

    const payloadByteLength = ERROR_PREFIX_BYTES + messageBytes.byteLength
    const bytes = createFrame(FRAME_TYPES.ERROR, retryable ? 1 : 0, payloadByteLength)
    const view = new DataView(bytes.buffer)
    const offset = FRAME_HEADER_BYTES

    view.setUint16(offset, uint16(code, 'error.code'), true)
    view.setUint16(offset + 2, messageBytes.byteLength, true)
    view.setUint32(offset + 4, uint32(contextTick, 'error.contextTick'), true)
    bytes.set(messageBytes, offset + ERROR_PREFIX_BYTES)
    return bytes
}

export function decodeErrorFrame(input)
{
    return guardedDecode(() =>
    {
        const frame = readHeader(input, FRAME_TYPES.ERROR)
        if((frame.flagsOrCount & 0xfe) !== 0)
            throw new ProtocolError('error frame contains reserved flags')

        if(frame.payloadByteLength < ERROR_PREFIX_BYTES)
            throw new ProtocolError('error frame payload is shorter than its prefix')

        const offset = frame.payloadOffset
        const messageLength = frame.view.getUint16(offset + 2, true)
        if(frame.payloadByteLength !== ERROR_PREFIX_BYTES + messageLength)
            throw new ProtocolError('error frame message length does not match its payload')

        return {
            protocolVersion: frame.protocolVersion,
            code: frame.view.getUint16(offset, true),
            retryable: (frame.flagsOrCount & 1) !== 0,
            contextTick: frame.view.getUint32(offset + 4, true),
            message: textDecoder.decode(frame.bytes.slice(
                offset + ERROR_PREFIX_BYTES,
                offset + ERROR_PREFIX_BYTES + messageLength,
            )),
        }
    })
}
