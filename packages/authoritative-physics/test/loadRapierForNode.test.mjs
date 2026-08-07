import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadRapierForNode } from './loadRapierForNode.mjs'

test('Node Rapier loader removes its patched temporary sandbox after module evaluation', async () =>
{
    const parent = await mkdtemp(join(tmpdir(), 'ch-folio-rapier-loader-test-'))
    let observedRoot = null

    try
    {
        const RAPIER = await loadRapierForNode({
            temporaryParent: parent,
            onTemporaryRoot(root)
            {
                observedRoot = root
            },
        })

        assert.equal(typeof observedRoot, 'string')
        assert.equal(observedRoot.startsWith(`${parent}/`), true)
        assert.deepEqual(await readdir(parent), [])

        const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
        try
        {
            world.step()
        }
        finally
        {
            world.free()
        }
    }
    finally
    {
        await rm(parent, { recursive: true, force: true })
    }
})
