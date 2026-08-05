import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    MESSAGE_TYPES,
    PROTOCOL_VERSION,
    STATE_FLAGS,
    createStateMessage,
    validateStateMessage,
} from '../sources/Game/Multiplayer/protocol.js'
import {
    DEFAULT_INTERPOLATION_DELAY_MS,
    MAX_SNAPSHOTS,
    SnapshotBuffer,
} from '../sources/Game/Multiplayer/SnapshotBuffer.js'

const closeTo = (actual, expected, epsilon = 1e-6) =>
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not close to ${expected}`)

test('multiplayer protocol exposes stable version, message types and flags', () =>
{
    assert.equal(PROTOCOL_VERSION, 1)
    assert.deepEqual(MESSAGE_TYPES, {
        WELCOME: 'welcome',
        JOINED: 'joined',
        STATE: 'state',
        LEFT: 'left',
        PING: 'ping',
        PONG: 'pong',
        ERROR: 'error',
    })
    assert.deepEqual(STATE_FLAGS, {
        BRAKING: 1,
        BOOSTING: 2,
        HONKING: 4,
        STEERING_LEFT: 8,
        STEERING_RIGHT: 16,
    })
})

test('state message clamps values and normalizes quaternion', () =>
{
    const message = createStateMessage({
        sequence: 12.8,
        timestamp: 1234.5,
        position: [1, 2, 3],
        quaternion: [0, 0, 0, 2],
        steering: 5,
        forwardSpeed: -500,
        flags: 255,
    })

    assert.deepEqual(message, {
        v: 1,
        t: 'state',
        seq: 12,
        ts: 1234,
        p: [1, 2, 3],
        q: [0, 0, 0, 1],
        st: 1,
        sp: -100,
        f: 31,
    })
    assert.equal(validateStateMessage(message), true)
})

test('state message rejects non-finite vectors and zero quaternions', () =>
{
    assert.throws(() => createStateMessage({
        sequence: 1,
        timestamp: 1,
        position: [0, Number.NaN, 0],
        quaternion: [0, 0, 0, 1],
        steering: 0,
        forwardSpeed: 0,
        flags: 0,
    }), /finite/)

    assert.throws(() => createStateMessage({
        sequence: 1,
        timestamp: 1,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 0],
        steering: 0,
        forwardSpeed: 0,
        flags: 0,
    }), /quaternion/)
})

test('snapshot buffer ignores stale sequences and remains bounded', () =>
{
    const buffer = new SnapshotBuffer({ interpolationDelayMs: 0 })

    for(let sequence = 1; sequence <= MAX_SNAPSHOTS + 5; sequence++)
    {
        assert.equal(buffer.add({
            seq: sequence,
            ts: sequence * 10,
            p: [sequence, 0, 0],
            q: [0, 0, 0, 1],
            st: 0,
            sp: 0,
            f: 0,
        }), true)
    }

    assert.equal(buffer.size, MAX_SNAPSHOTS)
    assert.equal(buffer.add({
        seq: MAX_SNAPSHOTS,
        ts: 9999,
        p: [999, 0, 0],
        q: [0, 0, 0, 1],
        st: 0,
        sp: 0,
        f: 0,
    }), false)
})

test('snapshot buffer interpolates position, scalars and quaternion at render delay', () =>
{
    assert.equal(DEFAULT_INTERPOLATION_DELAY_MS, 100)
    const buffer = new SnapshotBuffer()

    buffer.add({
        seq: 1,
        ts: 1000,
        p: [0, 0, 0],
        q: [0, 0, 0, 1],
        st: -1,
        sp: 0,
        f: STATE_FLAGS.BRAKING,
    })
    buffer.add({
        seq: 2,
        ts: 1100,
        p: [10, 2, -4],
        q: [0, 0, 1, 0],
        st: 1,
        sp: 20,
        f: STATE_FLAGS.BOOSTING,
    })

    const sampled = buffer.sample(1150)

    assert.deepEqual(sampled.p, [5, 1, -2])
    closeTo(sampled.q[2], Math.SQRT1_2)
    closeTo(sampled.q[3], Math.SQRT1_2)
    closeTo(sampled.st, 0)
    closeTo(sampled.sp, 10)
    assert.equal(sampled.f, STATE_FLAGS.BOOSTING)
})

test('snapshot quaternion interpolation uses the shortest path', () =>
{
    const buffer = new SnapshotBuffer({ interpolationDelayMs: 0 })
    buffer.add({ seq: 1, ts: 0, p: [0, 0, 0], q: [0, 0, 0, 1], st: 0, sp: 0, f: 0 })
    buffer.add({ seq: 2, ts: 100, p: [0, 0, 0], q: [0, 0, 0, -1], st: 0, sp: 0, f: 0 })

    const sampled = buffer.sample(50)
    assert.deepEqual(sampled.q, [0, 0, 0, 1])
})

test('remote vehicle is render-only and animates SU7 wheel nodes', async () =>
{
    const source = await readFile(
        new URL('../sources/Game/Multiplayer/RemoteVehicle.js', import.meta.url),
        'utf8',
    )

    assert.match(source, /vehicleTemplate\.clone\(true\)/)
    assert.match(source, /discoverSU7WheelNodes/)
    assert.match(source, /SnapshotBuffer/)
    assert.match(source, /removeFromParent\(\)/)
    assert.doesNotMatch(source, /RAPIER|PhysicsVehicle|createRigidBody|createCollider/)
})

test('remote players owns creation, update and cleanup of remote vehicles', async () =>
{
    const source = await readFile(
        new URL('../sources/Game/Multiplayer/RemotePlayers.js', import.meta.url),
        'utf8',
    )

    assert.match(source, /new Map\(\)/)
    assert.match(source, /new RemoteVehicle/)
    assert.match(source, /upsert\(/)
    assert.match(source, /remove\(/)
    assert.match(source, /clear\(/)
    assert.match(source, /update\(/)
})

test('server transport supports rooms, guarded reconnect and explicit shutdown', async () =>
{
    const source = await readFile(
        new URL('../sources/Game/Server.js', import.meta.url),
        'utf8',
    )

    assert.match(source, /start\(\{\s*room\s*=\s*['"]public['"]\s*\}\s*=\s*\{\}\)/)
    assert.match(source, /searchParams\.set\(['"]room['"],\s*this\.room\)/)
    assert.match(source, /this\.connecting/)
    assert.match(source, /scheduleReconnect\(/)
    assert.match(source, /Math\.min\(15000/)
    assert.match(source, /\n\s*stop\(\)/)
})

test('multiplayer publishes at 12 Hz and clears remote players on disconnect', async () =>
{
    const source = await readFile(
        new URL('../sources/Game/Multiplayer/Multiplayer.js', import.meta.url),
        'utf8',
    )

    assert.match(source, /STATE_UPLOAD_HZ\s*=\s*12/)
    assert.match(source, /new RemotePlayers\(game\)/)
    assert.match(source, /createStateMessage\(/)
    assert.match(source, /MESSAGE_TYPES\.WELCOME/)
    assert.match(source, /MESSAGE_TYPES\.STATE/)
    assert.match(source, /MESSAGE_TYPES\.LEFT/)
    assert.match(source, /remotePlayers\.clear\(\)/)
})

test('multiplayer resolves the loaded local visual chassis as its clone template', async () =>
{
    const source = await readFile(
        new URL('../sources/Game/Multiplayer/Multiplayer.js', import.meta.url),
        'utf8',
    )

    assert.match(source, /resolveVehicleTemplate\(/)
    assert.match(source, /world\?\.visualVehicle\?\.parts\?\.chassis/)
    assert.match(source, /remoteVehicleTemplate/)
})

test('application bootstrap keeps multiplayer optional and exposes it for public debugging', async () =>
{
    const source = await readFile(
        new URL('../sources/index.js', import.meta.url),
        'utf8',
    )

    assert.match(source, /Multiplayer\.js/)
    assert.match(source, /new Multiplayer\(game\)/)
    assert.match(source, /VITE_MULTIPLAYER_ENABLED/)
    assert.match(source, /VITE_SERVER_URL/)
    assert.match(source, /multiplayer\.start\(\{\s*room:\s*multiplayerRoom\s*\}\)/)
    assert.match(source, /window\.multiplayer\s*=\s*multiplayer/)
})
