import RAPIER from '@dimforge/rapier3d'
import { describe, expect, test } from 'vitest'

import {
    REQUIRED_SCENARIO_IDS,
    scenarioFixtures,
} from '../../../packages/authoritative-physics/test/scenarioCatalog.js'
import {
    runAuthoritativeScenario,
} from '../../../packages/authoritative-physics/test/scenarioHarness.mjs'

describe('authoritative fixtures in workerd', () =>
{
    test('loads the exact approved eleven-scenario catalog', () =>
    {
        expect(scenarioFixtures.map(({ fixture }) => fixture.id))
            .toEqual(REQUIRED_SCENARIO_IDS)
    })

    for(const { fixture } of scenarioFixtures)
    {
        test(`${fixture.id} matches Node checksums and snapshot hashes`, async () =>
        {
            const actual = await runAuthoritativeScenario({ RAPIER, fixture })
            expect(actual.checksums).toEqual(fixture.expected.checksums)
            expect(actual.snapshotHashes).toEqual(fixture.expected.snapshotHashes)
        })
    }
})
