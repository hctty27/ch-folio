import {
    FRAME_TYPES,
    LIFECYCLE_FRAME_TYPES,
    ROOM_SLOT_STATES,
    decodeFullSyncRequest,
    decodeInputBatch,
    decodeSyncReady,
} from '@ch-folio/authoritative-physics'
import { AuthoritativeGameRoom as BaseAuthoritativeGameRoom } from './AuthoritativeGameRoom'
import { SESSION_STATES } from './SessionRegistry'

const INVALID_FRAME_CODE = 2
const UNEXPECTED_FRAME_CODE = 3
const STALE_CONNECTION_CODE = 6
const INVALID_FRAME_MESSAGE = 'INVALID_FRAME'
const UNEXPECTED_FRAME_MESSAGE = 'UNEXPECTED_FRAME'
const STALE_CONNECTION_MESSAGE = 'STALE_CONNECTION'

type ActiveAttachment = {
    protocolVersion: 2
    handshake: 'awaiting_handshake' | 'processing_handshake' | 'session_active'
    clientTick: number | null
    playerId: number | null
    entityOrder: number | null
    generation: number | null
}

type SimulationSlot = {
    slotState: number
    hasBody: boolean
}

type RuntimeAccess = {
    currentTick: number
    getAttachment(socket: WebSocket): ActiveAttachment
    rejectSocket(socket: WebSocket, code: number, message: string, closeCode: number): void
    sendFullSync(socket: WebSocket): boolean
    sessions: {
        isCurrentController(playerId: number, generation: number): boolean
        setState(options: {
            playerId: number
            generation: number
            state: 'syncing' | 'waiting_spawn' | 'active'
        }): boolean
    }
    simulation: {
        getSlot(entityOrder: number): SimulationSlot
        markSyncReady(entityOrder: number): unknown
        queueInput(entityOrder: number, input: unknown): boolean
    } | null
}

export class AuthoritativeGameRoom extends BaseAuthoritativeGameRoom
{
    override async webSocketMessage(
        socket: WebSocket,
        message: string | ArrayBuffer,
    ): Promise<void>
    {
        const runtime = this as unknown as RuntimeAccess
        const attachment = runtime.getAttachment(socket)

        if(attachment.handshake !== 'session_active')
        {
            await super.webSocketMessage(socket, message)
            return
        }

        if(
            attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
            || !runtime.sessions.isCurrentController(
                attachment.playerId,
                attachment.generation,
            )
        )
        {
            runtime.rejectSocket(
                socket,
                STALE_CONNECTION_CODE,
                STALE_CONNECTION_MESSAGE,
                1008,
            )
            return
        }

        if(typeof message === 'string')
        {
            runtime.rejectSocket(
                socket,
                INVALID_FRAME_CODE,
                INVALID_FRAME_MESSAGE,
                1003,
            )
            return
        }

        try
        {
            const frameType = new Uint8Array(message)[0]
            if(frameType === LIFECYCLE_FRAME_TYPES.SYNC_READY)
            {
                decodeSyncReady(message)
                this.acceptSyncReady(runtime, attachment)
                return
            }

            if(frameType === FRAME_TYPES.INPUT_BATCH)
            {
                const inputs = decodeInputBatch(message)
                this.acceptInputs(runtime, attachment, inputs)
                return
            }

            if(frameType === LIFECYCLE_FRAME_TYPES.FULL_SYNC_REQUEST)
            {
                decodeFullSyncRequest(message)
                if(!runtime.sendFullSync(socket))
                    throw new Error('unable to send full sync')
                return
            }

            runtime.rejectSocket(
                socket,
                UNEXPECTED_FRAME_CODE,
                UNEXPECTED_FRAME_MESSAGE,
                1008,
            )
        }
        catch(error)
        {
            console.warn('[AuthoritativeGameRoom] Invalid active-session frame', error)
            runtime.rejectSocket(
                socket,
                INVALID_FRAME_CODE,
                INVALID_FRAME_MESSAGE,
                1002,
            )
        }
    }

    private acceptSyncReady(
        runtime: RuntimeAccess,
        attachment: ActiveAttachment,
    ): void
    {
        const simulation = runtime.simulation
        if(
            simulation === null
            || attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
        )
            throw new Error('active session has no simulation slot')

        const slot = simulation.getSlot(attachment.entityOrder)
        if(slot.slotState === ROOM_SLOT_STATES.SYNCING)
            simulation.markSyncReady(attachment.entityOrder)
        else if(
            slot.slotState !== ROOM_SLOT_STATES.WAITING_SPAWN
            && slot.slotState !== ROOM_SLOT_STATES.ACTIVE
        )
            throw new Error('session cannot become sync-ready from its current state')

        runtime.sessions.setState({
            playerId: attachment.playerId,
            generation: attachment.generation,
            state: slot.slotState === ROOM_SLOT_STATES.ACTIVE
                ? SESSION_STATES.ACTIVE
                : SESSION_STATES.WAITING_SPAWN,
        })
    }

    private acceptInputs(
        runtime: RuntimeAccess,
        attachment: ActiveAttachment,
        inputs: ReturnType<typeof decodeInputBatch>,
    ): void
    {
        const simulation = runtime.simulation
        if(
            simulation === null
            || attachment.playerId === null
            || attachment.entityOrder === null
            || attachment.generation === null
        )
            throw new Error('active session has no simulation slot')

        const slot = simulation.getSlot(attachment.entityOrder)
        for(const input of inputs)
            simulation.queueInput(attachment.entityOrder, input)

        if(slot.slotState === ROOM_SLOT_STATES.ACTIVE)
        {
            runtime.sessions.setState({
                playerId: attachment.playerId,
                generation: attachment.generation,
                state: SESSION_STATES.ACTIVE,
            })
        }
    }
}
