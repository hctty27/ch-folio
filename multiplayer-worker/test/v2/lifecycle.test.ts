import {
    SELF,
    runInDurableObject,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import {
    FRAME_TYPES,
    LIFECYCLE_FRAME_TYPES,
    ROOM_SLOT_STATES,
    decodeErrorFrame,
    decodeFullSyncFrame,
    decodeResume,
    encodeFullSyncRequest,
    encodeHello,
    encodeInputBatch,
    encodeSyncReady,
    quantizeInput,
} from '@ch-folio/authoritative-physics'
import { expect, test } from 'vitest'

import { AuthoritativeGameRoom } from '../../src/v2/LifecycleAuthoritativeGameRoom'

type RuntimeProbe = {
    scheduler: { stop(): void }
    simulation: {
        currentTick: number
        getSlot(entityOrder: number): {
            slotState: number
            hasBody: boolean
            queuedInputs: Map<number, unknown>
        }
    }
    sessions: {
        readSession(playerId: number): { state: string } | null
    }
    advanceOneTick(): void
    webSocketClose(socket: WebSocket, code: number, reason: string, clean: boolean): void
}

function nextMessage(socket: WebSocket): Promise<MessageEvent>
{
    return new Promise((resolve, reject) =>
    {
        const onMessage = (event: MessageEvent): void =>
        {
            socket.removeEventListener('error', onError)
            resolve(event)
        }
        const onError = (): void =>
        {
            socket.removeEventListener('message', onMessage)
            reject(new Error('WebSocket errored before the next message'))
        }
        socket.addEventListener('message', onMessage, { once: true })
        socket.addEventListener('error', onError, { once: true })
    })
}

function bytes(data: unknown): Uint8Array
{
    if(data instanceof ArrayBuffer)
        return new Uint8Array(data)
    if(ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    throw new TypeError('expected binary message')
}

async function openSocket(room: string): Promise<WebSocket>
{
    const response = await SELF.fetch(
        `https://worker.test/ws?room=${room}&protocol=2`,
        { headers: { Upgrade: 'websocket' } },
    )
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    socket.binaryType = 'arraybuffer'
    socket.accept()
    expect(decodeErrorFrame(bytes((await nextMessage(socket)).data)).message)
        .toBe('HELLO_REQUIRED')
    return socket
}

async function nextFrame(socket: WebSocket, frameType: number): Promise<Uint8Array>
{
    for(let index = 0; index < 20; index++)
    {
        const frame = bytes((await nextMessage(socket)).data)
        if(frame[0] === frameType)
            return frame
    }
    throw new Error(`frame type ${frameType} not received`)
}

test('sync-ready gates spawning, input batches reach active slots, and clients can request full sync', async () =>
{
    const room = `lifecycle-${crypto.randomUUID()}`
    const socket = await openSocket(room)
    const grantPromise = nextMessage(socket)
    const syncPromise = nextMessage(socket)
    socket.send(encodeHello({ clientTick: 0 }))
    const grant = decodeResume(bytes((await grantPromise).data))
    decodeFullSyncFrame(bytes((await syncPromise).data))

    const stub = env.AUTHORITATIVE_ROOM.getByName(room)
    await runInDurableObject(stub, async (instance: AuthoritativeGameRoom) =>
    {
        const probe = instance as unknown as RuntimeProbe
        probe.scheduler.stop()
        const slot = probe.simulation.getSlot(1)
        expect(slot.slotState).toBe(ROOM_SLOT_STATES.SYNCING)
        expect(slot.hasBody).toBe(false)
    })

    expect(encodeSyncReady()[0]).toBe(LIFECYCLE_FRAME_TYPES.SYNC_READY)
    socket.send(encodeSyncReady())
    await new Promise((resolve) => setTimeout(resolve, 0))

    let inputTick = 0
    await runInDurableObject(stub, async (instance: AuthoritativeGameRoom) =>
    {
        const probe = instance as unknown as RuntimeProbe
        probe.scheduler.stop()
        let slot = probe.simulation.getSlot(1)
        expect(slot.slotState).toBe(ROOM_SLOT_STATES.WAITING_SPAWN)

        for(let count = 0; count < 6 && !slot.hasBody; count++)
        {
            probe.advanceOneTick()
            slot = probe.simulation.getSlot(1)
        }
        expect(slot.slotState).toBe(ROOM_SLOT_STATES.ACTIVE)
        expect(slot.hasBody).toBe(true)
        inputTick = probe.simulation.currentTick + 3
    })

    socket.send(encodeInputBatch([ quantizeInput({
        clientTick: inputTick,
        sequence: 9,
        throttle: 1,
        brake: 0,
        steering: 0.25,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    }) ]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    await runInDurableObject(stub, async (instance: AuthoritativeGameRoom) =>
    {
        const probe = instance as unknown as RuntimeProbe
        probe.scheduler.stop()
        expect(probe.simulation.getSlot(1).queuedInputs.has(inputTick)).toBe(true)
        expect(probe.sessions.readSession(grant.playerId)?.state).toBe('active')
    })

    const requested = nextFrame(socket, FRAME_TYPES.FULL_SYNC)
    expect(encodeFullSyncRequest()[0]).toBe(LIFECYCLE_FRAME_TYPES.FULL_SYNC_REQUEST)
    socket.send(encodeFullSyncRequest())
    decodeFullSyncFrame(await requested)

    await runInDurableObject(stub, async (instance: AuthoritativeGameRoom, state) =>
    {
        const probe = instance as unknown as RuntimeProbe
        probe.scheduler.stop()
        const serverSocket = state.getWebSockets()[0]
        probe.webSocketClose(serverSocket, 1000, 'test complete', true)
        for(let tick = 0; tick < 180; tick++)
            probe.advanceOneTick()
    })
})
