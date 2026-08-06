import RAPIER from '@dimforge/rapier3d'
import { describe, expect, test } from 'vitest'

import {
    REQUIRED_SCENARIO_IDS,
    scenarioFixtures as importedScenarioFixtures,
} from '../../../packages/authoritative-physics/test/scenarioCatalog.js'
import {
    runAuthoritativeScenario,
} from '../../../packages/authoritative-physics/test/scenarioHarness.mjs'

type ScenarioExpectation = {
    checksums: Array<{ tick: number; checksum32: number }>
    snapshotHashes: Array<{ tick: number; sha256: string }>
}

type ScenarioFixture = {
    id: string
    expected: ScenarioExpectation
    [key: string]: unknown
}

type ScenarioCatalogEntry = {
    fileName: string
    fixture: ScenarioFixture
}

const scenarioFixtures = importedScenarioFixtures as unknown as readonly ScenarioCatalogEntry[]

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
