import assert from 'node:assert/strict'
import test from 'node:test'

import {
    BENCHMARK_FRAME_TYPES,
    decodeBenchmarkSummary,
    decodeBenchmarkSummaryRequest,
    digestBenchmarkToken,
    encodeBenchmarkSummary,
    encodeBenchmarkSummaryRequest,
} from '../src/index.js'

test('benchmark summary request uses a fixed 32-byte digest payload', async () =>
{
    const tokenDigest = await digestBenchmarkToken('task-18-test-token-with-32-bytes-minimum')
    const frame = encodeBenchmarkSummaryRequest({ tokenDigest })
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)

    assert.equal(frame.byteLength, 40)
    assert.equal(view.getUint8(0), BENCHMARK_FRAME_TYPES.SUMMARY_REQUEST)
    assert.equal(view.getUint8(1), 0)
    assert.equal(view.getUint16(2, true), 2)
    assert.equal(view.getUint32(4, true), 32)
    assert.deepEqual(decodeBenchmarkSummaryRequest(frame), { tokenDigest })
})

test('benchmark summary is bounded machine-readable JSON', () =>
{
    const summary = {
        schemaVersion: 1,
        mode: 'durable-object',
        room: 'task-18',
        currentTick: 36000,
        metrics: {
            ticks: 36000,
            phases: {
                totalTick: { p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 },
            },
        },
    }
    const frame = encodeBenchmarkSummary(summary)
    const decoded = decodeBenchmarkSummary(frame)

    assert.equal(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint8(0), BENCHMARK_FRAME_TYPES.SUMMARY)
    assert.deepEqual(decoded, summary)
    assert.throws(() => encodeBenchmarkSummary({ payload: 'x'.repeat(70_000) }), /exceeds/i)
})
