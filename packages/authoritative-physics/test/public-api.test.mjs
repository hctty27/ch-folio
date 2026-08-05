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

test('shared package public entry exposes every protocol-v2 codec', () =>
{
    for(const exportName of PROTOCOL_EXPORTS)
    {
        assert.ok(exportName in physics, `missing public export ${exportName}`)
    }
})
