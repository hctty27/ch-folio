import RAPIER from '@dimforge/rapier3d'
import { createAuthoritativeScenarioAdapter } from '../../packages/authoritative-physics/test/scenarioHarness.mjs'

export function createNodeScenarioAdapter({ fixture })
{
    return createAuthoritativeScenarioAdapter({ RAPIER, fixture })
}
