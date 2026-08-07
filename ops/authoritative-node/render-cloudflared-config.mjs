import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const HOST_LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/u

function validateHostname(value)
{
    if(typeof value !== 'string')
        throw new TypeError('staging hostname must be a DNS hostname')
    const hostname = value.trim().toLowerCase()
    if(hostname.length === 0 || hostname.length > 253 || hostname.includes('://'))
        throw new TypeError('staging hostname must be a DNS hostname')
    const labels = hostname.split('.')
    if(labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label)))
        throw new TypeError('staging hostname must be a DNS hostname')
    return hostname
}

function validateTunnelId(value)
{
    const tunnelId = String(value ?? '').trim().toLowerCase()
    if(!UUID.test(tunnelId))
        throw new TypeError('tunnel ID must be a UUID')
    return tunnelId
}

function validateCredentialsFile(value)
{
    if(typeof value !== 'string' || !isAbsolute(value) || !SAFE_ABSOLUTE_PATH.test(value))
        throw new TypeError('tunnel credentials file must be an absolute safe path')
    return value
}

export function renderCloudflaredConfig({ hostname, tunnelId, credentialsFile })
{
    const validatedHostname = validateHostname(hostname)
    const validatedTunnelId = validateTunnelId(tunnelId)
    const validatedCredentialsFile = validateCredentialsFile(credentialsFile)

    return [
        `tunnel: ${validatedTunnelId}`,
        `credentials-file: ${validatedCredentialsFile}`,
        'ingress:',
        `  - hostname: ${validatedHostname}`,
        '    service: http://127.0.0.1:8080',
        '  - service: http_status:404',
        '',
    ].join('\n')
}

function main()
{
    const config = renderCloudflaredConfig({
        hostname: process.env.AUTHORITATIVE_STAGING_HOSTNAME,
        tunnelId: process.env.AUTHORITATIVE_STAGING_TUNNEL_ID,
        credentialsFile: process.env.AUTHORITATIVE_STAGING_TUNNEL_CREDENTIALS_FILE,
    })
    process.stdout.write(config)
}

const isMain = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if(isMain)
    main()
