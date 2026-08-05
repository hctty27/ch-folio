import { SELF } from 'cloudflare:test'
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

    test('exposes the Rapier v2 health endpoint through the Worker entrypoint', async () =>
    {
        const response = await SELF.fetch('https://worker.test/health/rapier-v2')
        const body = await response.json<{
            ok: boolean
            rapierVersion: string
            y: number
            snapshotBytes: number
        }>()

        expect(response.status).toBe(200)
        expect(body.ok).toBe(true)
        expect(body.rapierVersion).toBe('0.17.3')
        expect(Number.isFinite(body.y)).toBe(true)
        expect(body.snapshotBytes).toBeGreaterThan(0)
    })
})
