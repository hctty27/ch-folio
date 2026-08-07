import { createAuthoritativeServer } from './server.js'
import { runAuthoritativeWarmup } from './warmup.js'

export async function startAuthoritativeNode({
    config = {},
    warmup = runAuthoritativeWarmup,
    createServer = createAuthoritativeServer,
} = {})
{
    if(typeof warmup !== 'function')
        throw new TypeError('warmup must be a function')
    if(typeof createServer !== 'function')
        throw new TypeError('createServer must be a function')

    const warmupReport = await warmup()
    const service = createServer(config)

    try
    {
        await service.start()
    }
    catch(error)
    {
        try
        {
            await service.stop?.()
        }
        catch
        {
            // Preserve the original startup error.
        }
        throw error
    }

    return {
        service,
        warmup: warmupReport,
    }
}
