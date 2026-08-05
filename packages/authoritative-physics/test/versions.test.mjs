import assert from 'node:assert/strict'
import test from 'node:test'

import {
    RAPIER_VERSION,
    VERSIONS,
    assertCompatibility,
} from '../src/versions.js'

test('versions are exact and incompatible peers are rejected', () =>
{
    assert.equal(RAPIER_VERSION, '0.17.3')
    assert.deepEqual(VERSIONS, {
        protocolVersion: 2,
        vehiclePhysicsVersion: 1,
        mapCollisionVersion: 1,
    })
    assert.doesNotThrow(() => assertCompatibility(VERSIONS))
    assert.throws(
        () => assertCompatibility({ ...VERSIONS, protocolVersion: 1 }),
        /protocolVersion/,
    )
})
