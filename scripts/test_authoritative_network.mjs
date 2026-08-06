import assert from 'node:assert/strict'
import test from 'node:test'

import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { scenarioFixtures } from '../packages/authoritative-physics/test/scenarioCatalog.js'
import {
    NETWORK_CASES,
    runPredictionScenario,
    runSeededNetworkSimulation,
} from './authoritativeNetworkHarness.mjs'

const RAPIER = await loadRapierForNode()

function fixtureById(id)
{
    const found = scenarioFixtures.find(({ fixture }) => fixture.id === id)
    assert.ok(found, `missing fixture ${id}`)
    return found.fixture
}

test('browser prediction adapter matches every committed deterministic fixture', async () =>
{
    for(const { fixture } of scenarioFixtures)
    {
        const actual = await runPredictionScenario({ RAPIER, fixture })
        assert.deepEqual(actual.checksums, fixture.expected.checksums)
        assert.deepEqual(actual.snapshotHashes, fixture.expected.snapshotHashes)
    }
})

test('seeded network simulation covers latency, jitter, reordering, drops, and batching', async () =>
{
    const result = await runSeededNetworkSimulation({
        RAPIER,
        fixture: fixtureById('high-head-on'),
        seed: 'task-17-network',
        caseName: NETWORK_CASES.DELAY_JITTER_REORDER_DROP_BATCH,
    })

    assert.equal(result.minLatencyMs, 0)
    assert.equal(result.maxLatencyMs, 300)
    assert.ok(result.reorderedFrames > 0)
    assert.ok(result.droppedFrames > 0)
    assert.ok(result.batchedDeliveries > 0)
    assert.equal(result.persistentDivergence, 0)
    assert.equal(result.finalServerChecksum, result.finalClientChecksum)
})

test('authority older than one second requests hard sync instead of partial rollback', async () =>
{
    const result = await runSeededNetworkSimulation({
        RAPIER,
        fixture: fixtureById('rear-end'),
        seed: 'task-17-old-authority',
        caseName: NETWORK_CASES.AUTHORITY_OLDER_THAN_ONE_SECOND,
    })

    assert.equal(result.hardSyncReasons.includes('rollback-window-exceeded'), true)
    assert.equal(result.partialRollbackApplied, false)
    assert.equal(result.finalServerChecksum, result.finalClientChecksum)
})

test('disconnect during collision resumes before 180 ticks and expires at the boundary', async () =>
{
    const beforeExpiry = await runSeededNetworkSimulation({
        RAPIER,
        fixture: fixtureById('side-impact'),
        seed: 'task-17-resume-before',
        caseName: NETWORK_CASES.RESUME_BEFORE_GRACE_EXPIRY,
    })
    assert.equal(beforeExpiry.resumeAccepted, true)
    assert.equal(beforeExpiry.vehiclePersistedDuringGrace, true)
    assert.equal(beforeExpiry.finalServerChecksum, beforeExpiry.finalClientChecksum)

    const afterExpiry = await runSeededNetworkSimulation({
        RAPIER,
        fixture: fixtureById('side-impact'),
        seed: 'task-17-resume-after',
        caseName: NETWORK_CASES.RESUME_AFTER_GRACE_EXPIRY,
    })
    assert.equal(afterExpiry.resumeAccepted, false)
    assert.equal(afterExpiry.expiredAtTick, 180)
    assert.equal(afterExpiry.despawned, true)
})
