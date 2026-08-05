import msgpack from 'msgpack-lite'
import { v4 as uuidv4 } from 'uuid'
import { Events } from './Events.js'
import { Game } from './Game.js'

const normalizeRoom = (room) =>
{
    const value = String(room ?? 'public').trim().toLowerCase()
    const normalized = value.replace(/[^a-z0-9_-]/g, '-').slice(0, 64)
    return normalized || 'public'
}

export class Server
{
    constructor()
    {
        this.game = Game.getInstance()

        this.uuid = localStorage.getItem('uuid')
        if(!this.uuid)
        {
            this.uuid = uuidv4()
            localStorage.setItem('uuid', this.uuid)
        }

        this.connected = false
        this.connecting = false
        this.stopped = true
        this.initData = null
        this.room = 'public'
        this.reconnectAttempts = 0
        this.reconnectTimer = null
        this.socket = null
        this.events = new Events()
        document.documentElement.classList.add('is-server-offline')
    }

    start({ room = 'public' } = {})
    {
        if(!import.meta.env.VITE_SERVER_URL)
            return false

        this.room = normalizeRoom(room)
        this.stopped = false
        this.connect()
        return true
    }

    connect()
    {
        if(this.stopped || this.connected || this.connecting)
            return false

        this.connecting = true
        const url = new URL(import.meta.env.VITE_SERVER_URL, window.location.href)
        url.searchParams.set('room', this.room)

        const socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'
        this.socket = socket

        socket.addEventListener('message', (message) => this.onReceive(message))
        socket.addEventListener('open', () => this.onOpen(socket))
        socket.addEventListener('close', () => this.onClose(socket))
        socket.addEventListener('error', () =>
        {
            if(socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
                socket.close()
        })

        return true
    }

    onOpen(socket)
    {
        if(socket !== this.socket || this.stopped)
        {
            socket.close()
            return
        }

        this.connecting = false
        this.connected = true
        this.reconnectAttempts = 0
        this.initData = null
        document.documentElement.classList.remove('is-server-offline')
        document.documentElement.classList.add('is-server-online')
        this.events.trigger('connected')

        if(this.game.ticker?.elapsed > 10)
        {
            const html = /* html */`
                <div class="top">
                    <div class="title">多人服务器已连接</div>
                </div>
            `
            this.game.notifications?.show(
                html,
                'server-connected',
                8,
                null,
                'server-connected',
            )
        }
    }

    onClose(socket)
    {
        if(socket !== this.socket)
            return

        const wasConnected = this.connected
        this.socket = null
        this.connecting = false
        this.connected = false
        document.documentElement.classList.add('is-server-offline')
        document.documentElement.classList.remove('is-server-online')

        if(wasConnected)
        {
            this.events.trigger('disconnected')

            if(this.game.ticker?.elapsed > 10)
            {
                const html = /* html */`
                    <div class="top">
                        <div class="title">多人服务器连接已断开</div>
                    </div>
                `
                this.game.notifications?.show(
                    html,
                    'server-disconnected',
                    8,
                    null,
                    'server-disconnected',
                )
            }
        }

        this.scheduleReconnect()
    }

    scheduleReconnect()
    {
        if(this.stopped || this.reconnectTimer)
            return

        const delay = Math.min(15000, 1000 * 2 ** this.reconnectAttempts)
        this.reconnectAttempts++
        this.reconnectTimer = window.setTimeout(() =>
        {
            this.reconnectTimer = null
            this.connect()
        }, delay)
    }

    stop()
    {
        this.stopped = true
        this.connected = false
        this.connecting = false

        if(this.reconnectTimer)
        {
            window.clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        const socket = this.socket
        this.socket = null
        if(socket && socket.readyState < WebSocket.CLOSING)
            socket.close(1000, 'client shutdown')

        document.documentElement.classList.add('is-server-offline')
        document.documentElement.classList.remove('is-server-online')
    }

    onReceive(message)
    {
        try
        {
            const data = this.decode(message.data)
            if(this.initData === null)
                this.initData = data

            this.events.trigger('message', [ data ])
        }
        catch(error)
        {
            this.events.trigger('error', [ error ])
        }
    }

    send(message)
    {
        if(!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN)
            return false

        this.socket.send(this.encode(message))
        return true
    }

    decode(data)
    {
        if(typeof data === 'string')
            return JSON.parse(data)

        const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        return msgpack.decode(bytes)
    }

    encode(data)
    {
        return msgpack.encode(data)
    }
}
