import { Events } from './Events.js'

export class Server
{
    constructor()
    {
        this.connected = false
        this.initData = null
        this.events = new Events()
        document.documentElement.classList.add('is-server-offline')
    }

    start()
    {
        return false
    }

    connect()
    {
        return false
    }

    send()
    {
        return false
    }
}
