import { readServerConfig } from './config.js'
import { startAuthoritativeNode } from './startup.js'

const config = readServerConfig()
let service = null

async function shutdown(signal)
{
    try
    {
        if(service !== null)
            await service.stop()
        process.exitCode = 0
    }
    catch(error)
    {
        console.error('[authoritative-node] shutdown failed', error)
        process.exitCode = 1
    }
    finally
    {
        process.off('SIGINT', shutdown)
        process.off('SIGTERM', shutdown)
    }
    void signal
}

try
{
    const started = await startAuthoritativeNode({ config })
    service = started.service
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    console.log(
        `[authoritative-node] warmup complete: ${started.warmup.ticks} ticks, ${started.warmup.vehicles} vehicles`,
    )
    const address = service.address()
    console.log(`[authoritative-node] listening on ${address.address}:${address.port}`)
}
catch(error)
{
    console.error('[authoritative-node] startup failed', error)
    process.exitCode = 1
}
