const LABELS = Object.freeze({
    connecting: '正在连接多人房间…',
    syncing: '正在同步多人房间…',
    waiting_spawn: '正在等待安全出生点…',
    reconnecting: '连接中断，正在重连…',
    incompatible: '多人游戏版本不兼容',
})

const HIDDEN_STATES = new Set([ 'active', 'stopped' ])

function defaultDocument()
{
    try
    {
        return globalThis.document ?? null
    }
    catch
    {
        return null
    }
}

export class SyncOverlay
{
    constructor({ document = defaultDocument() } = {})
    {
        this.document = document
        this.state = 'stopped'
        this.element = null
        this.destroyed = false

        if(!this.document?.body || typeof this.document.createElement !== 'function')
            return

        const element = this.document.createElement('div')
        element.className = 'authoritative-multiplayer-status'
        element.setAttribute('role', 'status')
        element.setAttribute('aria-live', 'polite')
        element.hidden = true
        Object.assign(element.style, {
            position: 'fixed',
            left: '50%',
            top: '20px',
            transform: 'translateX(-50%)',
            zIndex: '10000',
            padding: '10px 14px',
            borderRadius: '8px',
            background: 'rgba(0, 0, 0, 0.72)',
            color: '#fff',
            fontFamily: 'sans-serif',
            fontSize: '14px',
            pointerEvents: 'none',
        })
        this.document.body.appendChild(element)
        this.element = element
    }

    setState(state, detail = null)
    {
        if(this.destroyed)
            return false

        this.state = String(state)
        if(this.element === null)
            return true

        const hidden = HIDDEN_STATES.has(this.state)
        this.element.hidden = hidden
        this.element.textContent = hidden
            ? ''
            : String(detail || LABELS[this.state] || this.state)
        return true
    }

    destroy()
    {
        if(this.destroyed)
            return

        this.destroyed = true
        this.element?.remove()
        this.element = null
    }
}
