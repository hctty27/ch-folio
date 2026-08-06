import { readServerConfig } from './config.js'
import { createAuthoritativeServer } from './server.js'

const config = readServerConfig()
const service = createAuthoritativeServer(config)

async function shutdown(signal)
{
    try
    {
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

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

service.start()
    .then(() =>
    {
        const address = service.address()
        console.log(`[authoritative-node] listening on ${address.address}:${address.port}`)
    })
    .catch((error) =>
    {
        console.error('[authoritative-node] startup failed', error)
        process.exitCode = 1
    })
