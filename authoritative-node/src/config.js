function parsePort(value)
{
    const port = Number(value ?? 8080)
    if(!Number.isInteger(port) || port < 0 || port > 65535)
        throw new RangeError('PORT must be an integer from 0 to 65535')
    return port
}

export function readServerConfig(env = process.env)
{
    const host = typeof env.HOST === 'string' && env.HOST.trim() !== ''
        ? env.HOST.trim()
        : '0.0.0.0'

    return {
        host,
        port: parsePort(env.PORT),
    }
}
