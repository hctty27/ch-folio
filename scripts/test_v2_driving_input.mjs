import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { quantizeInput } from '@ch-folio/authoritative-physics'
import { loadRapierForNode } from '../packages/authoritative-physics/test/loadRapierForNode.mjs'
import { PredictionWorld } from '../sources/Game/MultiplayerV2/PredictionWorld.js'

const RAPIER = await loadRapierForNode()
const mapData = JSON.parse(await readFile(
    new URL('../packages/authoritative-physics/generated/map-v1.json', import.meta.url),
    'utf8',
))

function input(tick, throttle)
{
    return quantizeInput({
        clientTick: tick,
        sequence: tick,
        throttle,
        brake: 0,
        steering: 0,
        suspensions: [ 'low', 'low', 'low', 'low' ],
        boosting: false,
        honking: false,
    })
}

test('v2 prediction moves the local vehicle under sustained forward input', () =>
{
    const prediction = new PredictionWorld({ RAPIER, mapData })
    prediction.add(1, mapData.spawns[0])

    for(let tick = 1; tick <= 60; tick++)
    {
        prediction.step({
            inputs: [ { entityOrder: 1, input: input(tick, 0) } ],
        })
    }

    const before = prediction.readState(1).position
    for(let tick = 61; tick <= 180; tick++)
    {
        prediction.step({
            inputs: [ { entityOrder: 1, input: input(tick, 1) } ],
        })
    }
    const after = prediction.readState(1).position
    const horizontalDistance = Math.hypot(after[0] - before[0], after[2] - before[2])

    assert.ok(horizontalDistance > 0.5, `expected forward input to move the car, moved ${horizontalDistance}m`)
    prediction.destroy()
})
