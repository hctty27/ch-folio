import assert from 'node:assert/strict'
import test from 'node:test'

import * as physics from '../src/index.js'

const PROTOCOL_EXPORTS = [
    'FRAME_HEADER_BYTES',
    'FRAME_TYPES',
    'INPUT_RECORD_BYTES',
    'ProtocolError',
    'STATE_RECORD_BYTES',
    'decodeErrorFrame',
    'decodeFullSyncFrame',
    'decodeHello',
    'decodeInputBatch',
    'decodeResume',
    'decodeStateFrame',
    'encodeErrorFrame',
    'encodeFullSyncFrame',
    'encodeHello',
    'encodeInputBatch',
    'encodeResume',
    'encodeStateFrame',
]

const MAP_EXPORTS = [
    'MAP_COLLISION_VERSION',
    'SPAWN_APPROACH_HORIZON_SECONDS',
    'SPAWN_COUNT',
    'SPAWN_SAFETY_HALF_EXTENTS',
    'loadAuthoritativeMap',
]

test('shared package public entry exposes every protocol-v2 codec', () =>
{
    for(const exportName of PROTOCOL_EXPORTS)
        assert.ok(exportName in physics, `missing public export ${exportName}`)
})

test('shared package public entry exposes the authoritative map contract', () =>
{
    for(const exportName of MAP_EXPORTS)
        assert.ok(exportName in physics, `missing public export ${exportName}`)
})
