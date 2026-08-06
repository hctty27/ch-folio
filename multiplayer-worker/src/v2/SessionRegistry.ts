import {
    constantTimeEqual,
    createResumeToken,
    digestResumeToken,
} from './crypto'

export const SESSION_STATES = Object.freeze({
    SYNCING: 'syncing',
    WAITING_SPAWN: 'waiting_spawn',
    ACTIVE: 'active',
    GRACE: 'grace',
} as const)

export const SESSION_GRACE_TICKS = 180
export const SESSION_MAX_SLOTS = 8

export type SessionState = typeof SESSION_STATES[keyof typeof SESSION_STATES]
type ResumableSessionState = Exclude<SessionState, typeof SESSION_STATES.GRACE>

export type SessionSnapshot = {
    room: string
    playerId: number
    entityOrder: number
    state: SessionState
    resumeTokenDigest: Uint8Array
    generation: number
    controllerActive: boolean
    disconnectTick: number | null
    graceExpiresTick: number | null
}

export type SessionGrant = SessionSnapshot & {
    resumeToken: string
}

type SessionRecord = SessionSnapshot & {
    resumeState: ResumableSessionState
}

type RegistryOptions = {
    maxSlots?: number
    graceTicks?: number
}

const RESUMABLE_STATES = new Set<SessionState>([
    SESSION_STATES.SYNCING,
    SESSION_STATES.WAITING_SPAWN,
    SESSION_STATES.ACTIVE,
])

function nonNegativeInteger(value: number, label: string): number
{
    if(!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${label} must be a non-negative safe integer`)
    return value
}

function uint32(value: number, label: string): number
{
    if(!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new RangeError(`${label} must be an unsigned 32-bit integer`)
    return value
}

function roomName(value: string): string
{
    if(typeof value !== 'string' || value.length < 1 || value.length > 64)
        throw new TypeError('room must be a non-empty string of at most 64 characters')
    return value
}

function cloneSnapshot(record: SessionRecord): SessionSnapshot
{
    return {
        room: record.room,
        playerId: record.playerId,
        entityOrder: record.entityOrder,
        state: record.state,
        resumeTokenDigest: record.resumeTokenDigest.slice(),
        generation: record.generation,
        controllerActive: record.controllerActive,
        disconnectTick: record.disconnectTick,
        graceExpiresTick: record.graceExpiresTick,
    }
}

function createGrant(record: SessionRecord, resumeToken: string): SessionGrant
{
    return {
        ...cloneSnapshot(record),
        resumeToken,
    }
}

export class SessionRegistry
{
    private readonly sessions = new Map<number, SessionRecord>()
    private readonly maxSlots: number
    private readonly graceTicks: number

    constructor(options: RegistryOptions = {})
    {
        this.maxSlots = options.maxSlots ?? SESSION_MAX_SLOTS
        this.graceTicks = options.graceTicks ?? SESSION_GRACE_TICKS

        if(!Number.isInteger(this.maxSlots) || this.maxSlots < 1 || this.maxSlots > 255)
            throw new RangeError('maxSlots must be an integer between 1 and 255')
        nonNegativeInteger(this.graceTicks, 'graceTicks')
    }

    get size(): number
    {
        return this.sessions.size
    }

    async createSession({
        room,
        currentTick = 0,
    }: {
        room: string
        currentTick?: number
    }): Promise<SessionGrant | null>
    {
        const normalizedRoom = roomName(room)
        const tick = nonNegativeInteger(currentTick, 'currentTick')
        this.expireGrace(tick)

        const entityOrder = this.findFreeEntityOrder()
        if(entityOrder === null)
            return null

        const playerId = this.createPlayerId()
        const resumeToken = createResumeToken()
        const resumeTokenDigest = await digestResumeToken(resumeToken)
        const record: SessionRecord = {
            room: normalizedRoom,
            playerId,
            entityOrder,
            state: SESSION_STATES.SYNCING,
            resumeState: SESSION_STATES.SYNCING,
            resumeTokenDigest,
            generation: 1,
            controllerActive: true,
            disconnectTick: null,
            graceExpiresTick: null,
        }

        this.sessions.set(playerId, record)
        return createGrant(record, resumeToken)
    }

    readSession(playerId: number): SessionSnapshot | null
    {
        const record = this.sessions.get(uint32(playerId, 'playerId'))
        return record === undefined ? null : cloneSnapshot(record)
    }

    setState({
        playerId,
        generation,
        state,
    }: {
        playerId: number
        generation: number
        state: ResumableSessionState
    }): boolean
    {
        if(!RESUMABLE_STATES.has(state))
            throw new TypeError('state must be syncing, waiting_spawn, or active')

        const record = this.sessions.get(uint32(playerId, 'playerId'))
        if(
            record === undefined
            || record.generation !== uint32(generation, 'generation')
            || !record.controllerActive
            || record.state === SESSION_STATES.GRACE
        )
            return false

        record.state = state
        record.resumeState = state
        return true
    }

    disconnect({
        playerId,
        generation,
        currentTick,
    }: {
        playerId: number
        generation: number
        currentTick: number
    }): boolean
    {
        const record = this.sessions.get(uint32(playerId, 'playerId'))
        const expectedGeneration = uint32(generation, 'generation')
        const tick = nonNegativeInteger(currentTick, 'currentTick')

        if(
            record === undefined
            || record.generation !== expectedGeneration
            || !record.controllerActive
            || record.state === SESSION_STATES.GRACE
        )
            return false

        record.resumeState = record.state
        record.state = SESSION_STATES.GRACE
        record.controllerActive = false
        record.disconnectTick = tick
        record.graceExpiresTick = tick + this.graceTicks
        return true
    }

    async resumeSession({
        room,
        playerId,
        resumeToken,
        currentTick,
    }: {
        room: string
        playerId: number
        resumeToken: string
        currentTick: number
    }): Promise<SessionGrant | null>
    {
        const normalizedRoom = roomName(room)
        const normalizedPlayerId = uint32(playerId, 'playerId')
        const tick = nonNegativeInteger(currentTick, 'currentTick')
        const record = this.sessions.get(normalizedPlayerId)

        if(record === undefined || record.room !== normalizedRoom)
            return null

        if(
            record.state !== SESSION_STATES.GRACE
            || record.graceExpiresTick === null
        )
            return null

        if(tick >= record.graceExpiresTick)
        {
            this.sessions.delete(record.playerId)
            return null
        }

        let candidateDigest: Uint8Array
        try
        {
            candidateDigest = await digestResumeToken(resumeToken)
        }
        catch
        {
            return null
        }

        if(!constantTimeEqual(candidateDigest, record.resumeTokenDigest))
            return null

        const rotatedToken = createResumeToken()
        const rotatedDigest = await digestResumeToken(rotatedToken)
        const nextGeneration = record.generation + 1
        uint32(nextGeneration, 'generation')

        record.resumeTokenDigest = rotatedDigest
        record.generation = nextGeneration
        record.state = record.resumeState
        record.controllerActive = true
        record.disconnectTick = null
        record.graceExpiresTick = null

        return createGrant(record, rotatedToken)
    }

    isCurrentController(playerId: number, generation: number): boolean
    {
        const record = this.sessions.get(uint32(playerId, 'playerId'))
        return record !== undefined
            && record.generation === uint32(generation, 'generation')
            && record.controllerActive
            && record.state !== SESSION_STATES.GRACE
    }

    expireGrace(currentTick: number): SessionSnapshot[]
    {
        const tick = nonNegativeInteger(currentTick, 'currentTick')
        const expired = Array.from(this.sessions.values())
            .filter((record) =>
                record.state === SESSION_STATES.GRACE
                && record.graceExpiresTick !== null
                && tick >= record.graceExpiresTick)
            .sort((left, right) => left.entityOrder - right.entityOrder)

        for(const record of expired)
            this.sessions.delete(record.playerId)

        return expired.map(cloneSnapshot)
    }

    release({
        playerId,
        generation,
    }: {
        playerId: number
        generation?: number
    }): boolean
    {
        const normalizedPlayerId = uint32(playerId, 'playerId')
        const record = this.sessions.get(normalizedPlayerId)
        if(record === undefined)
            return false

        if(generation !== undefined && record.generation !== uint32(generation, 'generation'))
            return false

        return this.sessions.delete(normalizedPlayerId)
    }

    clear(): void
    {
        this.sessions.clear()
    }

    private findFreeEntityOrder(): number | null
    {
        const occupied = new Set(
            Array.from(this.sessions.values(), (record) => record.entityOrder),
        )

        for(let entityOrder = 1; entityOrder <= this.maxSlots; entityOrder++)
        {
            if(!occupied.has(entityOrder))
                return entityOrder
        }

        return null
    }

    private createPlayerId(): number
    {
        const words = new Uint32Array(1)

        for(let attempt = 0; attempt < 128; attempt++)
        {
            crypto.getRandomValues(words)
            const candidate = words[0]
            if(candidate !== 0 && !this.sessions.has(candidate))
                return candidate
        }

        throw new Error('unable to allocate a unique playerId')
    }
}
