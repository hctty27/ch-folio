export const RESUME_TOKEN_BYTES = 32

const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{43}$/

function copyTokenBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array
{
    let source: Uint8Array

    if(input instanceof ArrayBuffer)
        source = new Uint8Array(input)
    else if(ArrayBuffer.isView(input))
        source = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    else
        throw new TypeError('resume token bytes must be an ArrayBuffer or typed-array view')

    if(source.byteLength !== RESUME_TOKEN_BYTES)
        throw new RangeError(`resume token must contain exactly ${RESUME_TOKEN_BYTES} bytes`)

    const copy = new Uint8Array(RESUME_TOKEN_BYTES)
    copy.set(source)
    return copy
}

export function resumeTokenFromBytes(input: ArrayBuffer | ArrayBufferView): string
{
    const bytes = copyTokenBytes(input)
    let binary = ''

    for(const byte of bytes)
        binary += String.fromCharCode(byte)

    return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '')
}

export function resumeTokenToBytes(token: string): Uint8Array
{
    if(typeof token !== 'string' || !BASE64URL_TOKEN.test(token))
        throw new TypeError('resume token must be canonical unpadded base64url')

    let binary: string
    try
    {
        binary = atob(`${token}=`.replaceAll('-', '+').replaceAll('_', '/'))
    }
    catch
    {
        throw new TypeError('resume token must be valid base64url')
    }

    const bytes = new Uint8Array(binary.length)
    for(let index = 0; index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index)

    if(bytes.byteLength !== RESUME_TOKEN_BYTES || resumeTokenFromBytes(bytes) !== token)
        throw new TypeError('resume token must be canonical 256-bit base64url')

    return bytes
}

export function createResumeToken(): string
{
    const bytes = new Uint8Array(RESUME_TOKEN_BYTES)
    crypto.getRandomValues(bytes)
    return resumeTokenFromBytes(bytes)
}

export async function digestResumeToken(
    token: string | ArrayBuffer | ArrayBufferView,
): Promise<Uint8Array>
{
    const bytes = typeof token === 'string'
        ? resumeTokenToBytes(token)
        : copyTokenBytes(token)
    const captured = new Uint8Array(RESUME_TOKEN_BYTES)
    captured.set(bytes)

    const digest = await crypto.subtle.digest('SHA-256', captured)
    return new Uint8Array(digest)
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean
{
    if(!(left instanceof Uint8Array) || !(right instanceof Uint8Array))
        throw new TypeError('constantTimeEqual expects Uint8Array values')

    if(left.byteLength !== right.byteLength)
        return false

    let difference = 0
    for(let index = 0; index < left.byteLength; index++)
        difference |= left[index] ^ right[index]

    return difference === 0
}
