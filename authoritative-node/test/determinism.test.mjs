import assert from 'node:assert/strict'
import test from 'node:test'
import { scenarioFixtures } from '../../packages/authoritative-physics/test/scenarioCatalog.js'
import { runScenarioWithAdapter } from '../../packages/authoritative-physics/test/scenarioHarness.mjs'
import { createNodeScenarioAdapter } from './nodeScenarioAdapter.mjs'

for(const { fileName, fixture } of scenarioFixtures)
{
    test(`Node adapter matches committed deterministic samples for ${fileName}`, async () =>
    {
        const actual = await runScenarioWithAdapter({
            fixture,
            adapter: createNodeScenarioAdapter({ fixture }),
        })
        assert.deepEqual(actual.checksums, fixture.expected.checksums)
        assert.deepEqual(actual.snapshotHashes, fixture.expected.snapshotHashes)
    })
}
