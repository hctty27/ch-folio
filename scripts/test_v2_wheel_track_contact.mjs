import assert from 'node:assert/strict'
import test from 'node:test'

import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'

const RAPIER = await loadRapierForNode()

test('airborne prediction wheels preserve finite contact points for visual tracks', () =>
{
    const prediction = new PredictionWorld({ RAPIER })
    prediction.add(1, {
        position: [ 0, 100, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
    })
    prediction.step()

    const state = prediction.readState(1)
    assert.equal(state.wheelContacts.length, 4)

    for(const contact of state.wheelContacts)
    {
        assert.equal(contact.inContact, false)
        assert.ok(Array.isArray(contact.contactPoint))
        assert.equal(contact.contactPoint.length, 3)
        assert.ok(contact.contactPoint.every(Number.isFinite))
    }

    prediction.destroy()
})
