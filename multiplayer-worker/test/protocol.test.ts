import { describe, expect, it } from 'vitest'
import {
    MAX_CLIENT_MESSAGES_PER_SECOND,
    MESSAGE_TYPES,
    PROTOCOL_VERSION,
    consumeRateLimit,
    createSocketAttachment,
    decodeMessage,
    encodeMessage,
    normalizeRoom,
    sanitizeClientState,
} from '../src/protocol'

describe('room normalization', () =>
{
    it('creates bounded lowercase room names', () =>
    {
        expect(normalizeRoom('  My Public Room!  ')).toBe('my-public-room-')
        expect(normalizeRoom('')).toBe('public')
        expect(normalizeRoom('a'.repeat(100))).toHaveLength(64)
    })
})

describe('vehicle state sanitization', () =>
{
    it('normalizes values and assigns server time', () =>
    {
        const state = sanitizeClientState({
            v: PROTOCOL_VERSION,
            t: MESSAGE_TYPES.STATE,
            seq: 4,
            ts: 1,
            p: [20000, 2, -20000],
            q: [0, 0, 0, 2],
            st: 4,
            sp: -400,
            f: 255,
        }, 9876.8, 3)

        expect(state).toEqual({
            v: PROTOCOL_VERSION,
            t: MESSAGE_TYPES.STATE,
            seq: 4,
            ts: 9876,
            p: [10000, 2, -10000],
            q: [0, 0, 0, 1],
            st: 1,
            sp: -100,
            f: 31,
        })
    })

    it('rejects stale, malformed and non-finite states', () =>
    {
        const valid = {
            v: PROTOCOL_VERSION,
            t: MESSAGE_TYPES.STATE,
            seq: 4,
            p: [0, 0, 0],
            q: [0, 0, 0, 1],
            st: 0,
            sp: 0,
            f: 0,
        }

        expect(() => sanitizeClientState(valid, 1, 4)).toThrow(/newer/)
        expect(() => sanitizeClientState({ ...valid, v: 2 }, 1, 0)).toThrow(/version/)
        expect(() => sanitizeClientState({ ...valid, p: [0, Number.NaN, 0] }, 1, 0)).toThrow(/finite/)
        expect(() => sanitizeClientState({ ...valid, q: [0, 0, 0, 0] }, 1, 0)).toThrow(/quaternion/)
    })
})

describe('per-socket rate limiting', () =>
{
    it('allows thirty messages per second and resets the window', () =>
    {
        let attachment = createSocketAttachment('player', 'public', 1000)

        for(let count = 0; count < MAX_CLIENT_MESSAGES_PER_SECOND; count++)
        {
            const result = consumeRateLimit(attachment, 1000)
            expect(result.allowed).toBe(true)
            attachment = result.attachment
        }

        const blocked = consumeRateLimit(attachment, 1000)
        expect(blocked.allowed).toBe(false)

        const reset = consumeRateLimit(blocked.attachment, 2000)
        expect(reset.allowed).toBe(true)
        expect(reset.attachment.messagesInWindow).toBe(1)
    })
})

describe('MessagePack transport', () =>
{
    it('round-trips compact protocol maps', () =>
    {
        const message = {
            v: PROTOCOL_VERSION,
            t: MESSAGE_TYPES.PING,
            ts: 123,
        }

        const decoded = decodeMessage(encodeMessage(message).buffer as ArrayBuffer)
        expect(decoded).toEqual(message)
    })
})
