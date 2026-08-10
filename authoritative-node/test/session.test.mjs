import assert from 'node:assert/strict'
import test from 'node:test'
import {
    RESUME_TOKEN_BYTES,
    constantTimeEqual,
    createResumeToken,
    digestResumeToken,
    resumeTokenFromBytes,
    resumeTokenToBytes,
} from '../src/token.js'
import {
    SESSION_GRACE_TICKS,
    SESSION_STATES,
    SessionRegistry,
} from '../src/SessionRegistry.js'

test('resume tokens are canonical 256-bit base64url and digest safely', async () =>
{
    const bytes = Uint8Array.from({ length: RESUME_TOKEN_BYTES }, (_, index) => index)
    const token = resumeTokenFromBytes(bytes)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u)
    assert.deepEqual(resumeTokenToBytes(token), bytes)
    assert.equal(resumeTokenFromBytes(resumeTokenToBytes(token)), token)

    const randomToken = createResumeToken()
    assert.match(randomToken, /^[A-Za-z0-9_-]{43}$/u)
    const left = await digestResumeToken(token)
    const right = await digestResumeToken(token)
    const different = await digestResumeToken(randomToken)
    assert.equal(left.byteLength, 32)
    assert.equal(constantTimeEqual(left, right), true)
    assert.equal(constantTimeEqual(left, different), false)
    assert.throws(() => resumeTokenToBytes(`${token}=`), /canonical/u)
})

test('registry allocates eight ordered slots and stores only token digests', async () =>
{
    const registry = new SessionRegistry()
    const grants = []
    for(let index = 0; index < 8; index++)
        grants.push(await registry.createSession({ room: 'alpha', currentTick: 0 }))

    assert.deepEqual(grants.map((grant) => grant.entityOrder), [ 1, 2, 3, 4, 5, 6, 7, 8 ])
    assert.equal(await registry.createSession({ room: 'alpha', currentTick: 0 }), null)
    assert.equal(registry.size, 8)

    const first = grants[0]
    const snapshot = registry.readSession(first.playerId)
    assert.equal(snapshot.state, SESSION_STATES.SYNCING)
    assert.equal(snapshot.entityOrder, 1)
    assert.equal(snapshot.resumeTokenDigest.byteLength, 32)
    assert.equal('resumeToken' in snapshot, false)

    assert.equal(registry.release({ playerId: first.playerId, generation: first.generation }), true)
    const replacement = await registry.createSession({ room: 'alpha', currentTick: 1 })
    assert.equal(replacement.entityOrder, 1)
})

test('disconnect and resume rotate credentials and invalidate stale generations', async () =>
{
    const registry = new SessionRegistry()
    const first = await registry.createSession({ room: 'alpha', currentTick: 10 })
    registry.setState({
        playerId: first.playerId,
        generation: first.generation,
        state: SESSION_STATES.ACTIVE,
    })

    assert.equal(registry.disconnect({
        playerId: first.playerId,
        generation: first.generation,
        currentTick: 20,
    }), true)
    assert.equal(registry.isCurrentController(first.playerId, first.generation), false)

    assert.equal(await registry.resumeSession({
        room: 'beta',
        playerId: first.playerId,
        resumeToken: first.resumeToken,
        currentTick: 21,
    }), null)

    const resumed = await registry.resumeSession({
        room: 'alpha',
        playerId: first.playerId,
        resumeToken: first.resumeToken,
        currentTick: 21,
    })
    assert.equal(resumed.generation, first.generation + 1)
    assert.notEqual(resumed.resumeToken, first.resumeToken)
    assert.equal(resumed.state, SESSION_STATES.ACTIVE)
    assert.equal(registry.isCurrentController(first.playerId, first.generation), false)
    assert.equal(registry.isCurrentController(first.playerId, resumed.generation), true)

    registry.disconnect({
        playerId: resumed.playerId,
        generation: resumed.generation,
        currentTick: 30,
    })
    assert.equal(await registry.resumeSession({
        room: 'alpha',
        playerId: resumed.playerId,
        resumeToken: first.resumeToken,
        currentTick: 31,
    }), null)
})

test('resume succeeds before tick 180 and expires exactly at the boundary', async () =>
{
    assert.equal(SESSION_GRACE_TICKS, 180)

    const before = new SessionRegistry()
    const first = await before.createSession({ room: 'alpha', currentTick: 0 })
    before.disconnect({ playerId: first.playerId, generation: first.generation, currentTick: 50 })
    const resumed = await before.resumeSession({
        room: 'alpha',
        playerId: first.playerId,
        resumeToken: first.resumeToken,
        currentTick: 50 + SESSION_GRACE_TICKS - 1,
    })
    assert.ok(resumed)

    const boundary = new SessionRegistry()
    const second = await boundary.createSession({ room: 'alpha', currentTick: 0 })
    boundary.disconnect({ playerId: second.playerId, generation: second.generation, currentTick: 50 })
    assert.equal(await boundary.resumeSession({
        room: 'alpha',
        playerId: second.playerId,
        resumeToken: second.resumeToken,
        currentTick: 50 + SESSION_GRACE_TICKS,
    }), null)
    assert.equal(boundary.readSession(second.playerId), null)
})
