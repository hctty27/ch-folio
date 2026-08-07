import {
    createHash,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto'

export const RESUME_TOKEN_BYTES = 32
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{43}$/u

function copyTokenBytes(input)
{
    let source
    if(input instanceof ArrayBuffer)
        source = new Uint8Array(input)
    else if(ArrayBuffer.isView(input))
        source = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    else
        throw new TypeError('resume token bytes must be an ArrayBuffer or typed-array view')

    if(source.byteLength !== RESUME_TOKEN_BYTES)
        throw new RangeError(`resume token must contain exactly ${RESUME_TOKEN_BYTES} bytes`)

    return Uint8Array.from(source)
}

export function resumeTokenFromBytes(input)
{
    return Buffer.from(copyTokenBytes(input)).toString('base64url')
}

export function resumeTokenToBytes(token)
{
    if(typeof token !== 'string' || !BASE64URL_TOKEN.test(token))
        throw new TypeError('resume token must be canonical unpadded base64url')

    const bytes = Uint8Array.from(Buffer.from(token, 'base64url'))
    if(bytes.byteLength !== RESUME_TOKEN_BYTES || resumeTokenFromBytes(bytes) !== token)
        throw new TypeError('resume token must be canonical 256-bit base64url')
    return bytes
}

export function createResumeToken()
{
    return randomBytes(RESUME_TOKEN_BYTES).toString('base64url')
}

export async function digestResumeToken(token)
{
    const bytes = typeof token === 'string'
        ? resumeTokenToBytes(token)
        : copyTokenBytes(token)
    return Uint8Array.from(createHash('sha256').update(bytes).digest())
}

export function constantTimeEqual(left, right)
{
    if(!(left instanceof Uint8Array) || !(right instanceof Uint8Array))
        throw new TypeError('constantTimeEqual expects Uint8Array values')
    if(left.byteLength !== right.byteLength)
        return false
    return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}
