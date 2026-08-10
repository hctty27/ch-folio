import assert from 'node:assert/strict'
import test from 'node:test'

import { VisualCorrection } from '../sources/Game/MultiplayerV2/VisualCorrection.js'

function state(position)
{
    return {
        entityOrder: 1,
        position: [ position, 0, 0 ],
        quaternion: [ 0, 0, 0, 1 ],
    }
}

test('overlapping 20Hz reconciliations preserve the currently rendered pose', () =>
{
    const correction = new VisualCorrection({ durationSeconds: 0.1 })

    correction.capture([ state(0) ], [ state(1) ])
    correction.advance(0.05)

    const predictedBeforeSecondRollback = state(1.5)
    const renderedBeforeSecondRollback = correction.apply(predictedBeforeSecondRollback)
    assert.equal(renderedBeforeSecondRollback.position[0], 1)

    const authoritativeAfterSecondRollback = state(1.2)
    correction.capture(
        [ predictedBeforeSecondRollback ],
        [ authoritativeAfterSecondRollback ],
    )

    const renderedAfterSecondRollback = correction.apply(authoritativeAfterSecondRollback)
    assert.ok(
        Math.abs(renderedAfterSecondRollback.position[0] - renderedBeforeSecondRollback.position[0]) < 1e-12,
        `expected no visual jump, before=${renderedBeforeSecondRollback.position[0]} after=${renderedAfterSecondRollback.position[0]}`,
    )
})
