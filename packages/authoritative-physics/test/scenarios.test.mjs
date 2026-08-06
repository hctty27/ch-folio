import assert from 'node:assert/strict'
import test from 'node:test'

import { loadRapierForNode } from './loadRapierForNode.mjs'
import {
    REQUIRED_SCENARIO_IDS,
    scenarioFixtures,
} from './scenarioCatalog.js'
import {
    assertExpectedUpdateAllowed,
    runAuthoritativeScenario,
    updateScenarioExpectations,
} from './scenarioHarness.mjs'

const RAPIER = await loadRapierForNode()

if(process.env.UPDATE_EXPECTED === '1')
{
    assertExpectedUpdateAllowed(process.env)
    await updateScenarioExpectations({ RAPIER, fixtures: scenarioFixtures })
}

test('authoritative scenario catalog contains the eleven approved deterministic cases', () =>
{
    assert.deepEqual(
        scenarioFixtures.map(({ fixture }) => fixture.id),
        REQUIRED_SCENARIO_IDS,
    )
    assert.equal(new Set(REQUIRED_SCENARIO_IDS).size, 11)
})

test('scenario expectation updates are rejected in CI', () =>
{
    assert.throws(
        () => assertExpectedUpdateAllowed({ CI: 'true', UPDATE_EXPECTED: '1' }),
        /refuses to update expected values in CI/i,
    )
    assert.throws(
        () => assertExpectedUpdateAllowed({ GITHUB_ACTIONS: 'true', UPDATE_EXPECTED: '1' }),
        /refuses to update expected values in CI/i,
    )
})

for(const { fixture } of scenarioFixtures)
{
    test(`${fixture.id} matches committed 20Hz checksums and 1Hz snapshot hashes`, async () =>
    {
        const actual = await runAuthoritativeScenario({ RAPIER, fixture })
        assert.deepEqual(actual.checksums, fixture.expected.checksums)
        assert.deepEqual(actual.snapshotHashes, fixture.expected.snapshotHashes)
    })
}
