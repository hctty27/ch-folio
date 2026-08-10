import {
    FRAME_HEADER_BYTES,
    FRAME_TYPES,
    VERSIONS,
    decodeResume,
    encodeHello,
    encodeResume,
} from '@ch-folio/authoritative-physics'
import { Events } from '../Events.js'

const DEFAULT_MAX_FRAME_BYTES = 17 * 1024 * 1024
const MAX_RECONNECT_DELAY_MS = 15000
const SERVER_FRAME_TYPES = new Set([
    FRAME_TYPES.RESUME,
    FRAME_TYPES.STATE,
    FRAME_TYPES.FULL_SYNC,
    FRAME_TYPES.ERROR,
])
const CREDENTIAL_QUERY_KEYS = [
    'token',
    'resumeToken',
    'resume_token',
    'playerId',
    'lastServerTick',
]

export function normalizeRoom(room)
{
    const value = String(room ?? 'public').trim().toLowerCase()
    const normalized = value
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
        .replace(/-+$/g, '')
    return normalized || 'public'
}

function binaryBytes(value, label = 'frame')
{
    if(value instanceof Uint8Array)
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if(value instanceof ArrayBuffer)
        return new Uint8Array(value)
    if(ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError(`${label} must be binary data`)
}

function positiveInteger(value, fallback, label)
{
    const resolved = value ?? fallback
    if(!Number.isSafeInteger(resolved) || resolved < 1)
        throw new TypeError(`${label} must be a positive safe integer`)
    return resolved
}

function defaultBaseHref()
{
    return globalThis.window?.location?.href
        ?? globalThis.location?.href
        ?? 'http://localhost/'
}

function cloneResume(resume)
{
    if(resume === null || resume === undefined)
        return null

    const resumeToken = binaryBytes(resume.resumeToken, 'resume.resumeToken')
    if(resumeToken.byteLength !== 32)
        throw new TypeError('resume.resumeToken must contain exactly 32 bytes')

    return {
        playerId: Number(resume.playerId) >>> 0,
        lastServerTick: Number(resume.lastServerTick ?? 0) >>> 0,
        resumeToken: resumeToken.slice(),
    }
}

export class Server
{
    constructor({
        WebSocketClass = globalThis.WebSocket,
        baseHref = defaultBaseHref(),
        maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
        setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
        clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
    } = {})
    {
        if(typeof WebSocketClass !== 'function')
            throw new TypeError('WebSocket is unavailable')
        if(typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function')
            throw new TypeError('timer functions are unavailable')

        this.WebSocketClass = WebSocketClass
        this.baseHref = String(baseHref)
        this.maxFrameBytes = positiveInteger(
            maxFrameBytes,
            DEFAULT_MAX_FRAME_BYTES,
            'maxFrameBytes',
        )
        this.setTimeoutFn = setTimeoutFn
        this.clearTimeoutFn = clearTimeoutFn

        this.events = new Events()
        this.connected = false
        this.connecting = false
        this.stopped = true
        this.url = null
        this.room = 'public'
        this.resume = null
        this.socket = null
        this.reconnectAttempts = 0
        this.reconnectTimer = null
    }

    start({ url, room = 'public', resume = null } = {})
    {
        if(!url || !this.stopped)
            return false

        try
        {
            this.url = String(url)
            this.room = normalizeRoom(room)
            this.resume = cloneResume(resume)
        }
        catch(error)
        {
            this.events.trigger('error', [ error ])
            return false
        }

        this.stopped = false
        this.reconnectAttempts = 0
        return this.connect()
    }

    connect()
    {
        if(this.stopped || this.connected || this.connecting || !this.url)
            return false

        let socket
        try
        {
            const url = new URL(this.url, this.baseHref)
            url.searchParams.set('room', this.room)
            url.searchParams.set('protocol', '2')
            for(const key of CREDENTIAL_QUERY_KEYS)
                url.searchParams.delete(key)

            this.connecting = true
            socket = new this.WebSocketClass(url)
            socket.binaryType = 'arraybuffer'
            this.socket = socket

            socket.addEventListener('open', () => this.onOpen(socket))
            socket.addEventListener('message', (event) => this.onMessage(socket, event))
            socket.addEventListener('close', (event) => this.onClose(socket, event))
            socket.addEventListener('error', () => this.onSocketError(socket))
            return true
        }
        catch(error)
        {
            this.connecting = false
            this.socket = null
            this.events.trigger('error', [ error ])
            this.scheduleReconnect()
            return false
        }
    }

    onOpen(socket)
    {
        if(socket !== this.socket || this.stopped)
        {
            this.closeSocket(socket, 1000, 'stale connection')
            return
        }

        this.connecting = false
        this.connected = true
        this.reconnectAttempts = 0

        const handshake = this.resume === null
            ? encodeHello({ clientTick: 0 })
            : encodeResume(this.resume)

        if(!this.sendFrame(handshake))
            return

        this.events.trigger('connected')
    }

    onMessage(socket, event)
    {
        if(socket !== this.socket || this.stopped)
            return

        try
        {
            if(typeof event?.data === 'string')
                throw Object.assign(new TypeError('protocol-v2 messages must be binary'), { closeCode: 1003 })

            const frame = this.validateIncomingFrame(event?.data)
            if(frame[0] === FRAME_TYPES.RESUME)
            {
                const rotated = decodeResume(frame)
                this.resume = cloneResume(rotated)
            }
            this.events.trigger('frame', [ frame ])
        }
        catch(error)
        {
            this.events.trigger('error', [ error ])
            const closeCode = Number(error?.closeCode) || 1002
            this.closeSocket(socket, closeCode, 'invalid protocol frame')
        }
    }

    validateIncomingFrame(value)
    {
        const bytes = binaryBytes(value)
        if(bytes.byteLength > this.maxFrameBytes)
        {
            const error = new RangeError(`frame exceeds ${this.maxFrameBytes} bytes`)
            error.closeCode = 1009
            throw error
        }
        if(bytes.byteLength < FRAME_HEADER_BYTES)
            throw new TypeError(`frame is shorter than the ${FRAME_HEADER_BYTES}-byte header`)

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const frameType = view.getUint8(0)
        const protocolVersion = view.getUint16(2, true)
        const payloadByteLength = view.getUint32(4, true)

        if(!SERVER_FRAME_TYPES.has(frameType))
            throw new TypeError(`unexpected server frame type ${frameType}`)
        if(protocolVersion !== VERSIONS.protocolVersion)
        {
            throw new TypeError(
                `incompatible protocolVersion: expected ${VERSIONS.protocolVersion}, received ${protocolVersion}`,
            )
        }
        if(payloadByteLength !== bytes.byteLength - FRAME_HEADER_BYTES)
        {
            throw new TypeError(
                `payload length mismatch: header ${payloadByteLength}, actual ${bytes.byteLength - FRAME_HEADER_BYTES}`,
            )
        }

        return bytes.slice()
    }

    onSocketError(socket)
    {
        if(socket !== this.socket || this.stopped)
            return

        this.events.trigger('error', [ new Error('authoritative multiplayer WebSocket error') ])
        this.closeSocket(socket, 1011, 'websocket error')
    }

    onClose(socket)
    {
        if(socket !== this.socket)
            return

        const wasConnected = this.connected
        this.socket = null
        this.connecting = false
        this.connected = false

        if(wasConnected)
            this.events.trigger('disconnected')

        this.scheduleReconnect()
    }

    scheduleReconnect()
    {
        if(this.stopped || this.reconnectTimer !== null)
            return false

        const delay = Math.min(
            MAX_RECONNECT_DELAY_MS,
            1000 * 2 ** this.reconnectAttempts,
        )
        this.reconnectAttempts++
        this.reconnectTimer = this.setTimeoutFn(() =>
        {
            this.reconnectTimer = null
            this.connect()
        }, delay)
        return true
    }

    sendFrame(frame)
    {
        const socket = this.socket
        if(
            !this.connected
            || socket === null
            || socket.readyState !== this.WebSocketClass.OPEN
        )
            return false

        try
        {
            const bytes = binaryBytes(frame)
            if(bytes.byteLength > this.maxFrameBytes)
                throw new RangeError(`frame exceeds ${this.maxFrameBytes} bytes`)
            socket.send(bytes)
            return true
        }
        catch(error)
        {
            this.events.trigger('error', [ error ])
            this.closeSocket(socket, 1011, 'send failed')
            return false
        }
    }

    stop()
    {
        const wasConnected = this.connected
        this.stopped = true
        this.connected = false
        this.connecting = false

        if(this.reconnectTimer !== null)
        {
            this.clearTimeoutFn(this.reconnectTimer)
            this.reconnectTimer = null
        }

        const socket = this.socket
        this.socket = null
        if(socket !== null && socket.readyState < this.WebSocketClass.CLOSING)
            this.closeSocket(socket, 1000, 'client shutdown')

        if(wasConnected)
            this.events.trigger('disconnected')
    }

    closeSocket(socket, code, reason)
    {
        try
        {
            if(socket.readyState < this.WebSocketClass.CLOSING)
                socket.close(code, reason)
        }
        catch(error)
        {
            this.events.trigger('error', [ error ])
        }
    }
}
