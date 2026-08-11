import assert from 'node:assert/strict'
import test from 'node:test'

import {
    runTwoClientCollisionScenario,
    runV2NetworkDrivingMatrix,
} from './v2NetworkDrivingHarness.mjs'

test('20/60/100/150ms RTT with jitter converges to near-zero late input and rollback', async () =>
{
    const results = await runV2NetworkDrivingMatrix({
        durationTicks: 600,
        warmupTicks: 180,
        rtts: [ 20, 60, 100, 150 ],
        jitters: [ 0, 10, 30 ],
    })

    assert.equal(results.length, 12)
    for(const result of results)
    {
        assert.ok(result.lateInputRate < 0.005, JSON.stringify(result))
        assert.ok(result.rollbackCount <= 1, JSON.stringify(result))
        assert.equal(result.hardSyncCount, 0, JSON.stringify(result))
        assert.ok(result.commandLeadTicks >= 4, JSON.stringify(result))
        assert.ok(result.commandLeadTicks <= 18, JSON.stringify(result))
        assert.ok(result.futureLeadMaxTicks <= 18, JSON.stringify(result))
        assert.equal(result.staleInputMax, 0, JSON.stringify(result))
    }
})

test('two-client head-on collision stays authoritative without rollback storm', async () =>
{
    const result = await runTwoClientCollisionScenario({
        collision: 'head-on',
        rttMs: 60,
        jitterMs: 10,
    })

    assert.equal(result.clients.length, 2)
    for(const client of result.clients)
    {
        assert.equal(client.hardSyncCount, 0, JSON.stringify(result))
        assert.ok(client.rollbackCount <= 1, JSON.stringify(result))
    }
    assert.equal(result.authoritativeConvergence, true, JSON.stringify(result))
})