import RAPIER from '@dimforge/rapier3d'
import { describe, expect, test } from 'vitest'

import { runRapierSmoke } from '../../src/v2/rapierSmoke'

describe('Rapier Worker smoke test', () =>
{
    test('steps a fixed-timestep world and produces a snapshot', () =>
    {
        const result = runRapierSmoke(RAPIER)

        expect(Number.isFinite(result.y)).toBe(true)
        expect(result.y).toBeLessThan(2)
        expect(result.snapshotBytes).toBeGreaterThan(0)
    })
})
