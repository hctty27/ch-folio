import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateNodeLoadTestGates } from './loadtest-authoritative-node.mjs'

function report(gauges = {})
{
    return {
        server: {
            phases: {
                totalTick: { p95Ms: 1, p99Ms: 2, maxMs: 3 },
            },
            gauges: {
                maxQueueDepth: 100,
                futureInputCountMax: 100,
                futureLeadMaxTicks: 18,
                staleInputMax: 0,
                lateInputRate: 0,
                persistentFutureQueueGrowth: false,
                ...gauges,
            },
            scheduler: { overloadCallbacks: 0 },
        },
        disconnects: 0,
        backlog: { persistent: 0 },
        divergence: { persistent: 0 },
        roomRestarts: 0,
    }
}

test('hosted gate accepts bounded future commands even when raw queue depth is non-zero', () =>
{
    assert.equal(evaluateNodeLoadTestGates(report()).pass, true)
})

test('hosted gate rejects stale backlog, excessive future lead, or persistent growth', () =>
{
    assert.equal(evaluateNodeLoadTestGates(report({ staleInputMax: 1 })).pass, false)
    assert.equal(evaluateNodeLoadTestGates(report({ futureLeadMaxTicks: 19 })).pass, false)
    assert.equal(evaluateNodeLoadTestGates(report({ futureLeadMaxTicks: 18 })).pass, true)
    assert.equal(evaluateNodeLoadTestGates(report({ persistentFutureQueueGrowth: true })).pass, false)
})
