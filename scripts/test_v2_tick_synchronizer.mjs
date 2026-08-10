import assert from 'node:assert/strict'
import test from 'node:test'
import {
    tickAdd,
    tickAfter,
    tickAtOrAfter,
    tickDelta,
} from '../sources/Game/MultiplayerV2/TickMath.js'
import { TickSynchronizer } from '../sources/Game/MultiplayerV2/TickSynchronizer.js'

test('uint32 tick ordering stays correct across wrap', () =>
{
    assert.equal(tickAdd(0xffffffff, 1), 0)
    assert.equal(tickAdd(1, -3), 0xfffffffe)
    assert.equal(tickDelta(1, 0xffffffff), 2)
    assert.equal(tickAfter(1, 0xffffffff), true)
    assert.equal(tickAfter(0xffffffff, 1), false)
    assert.equal(tickAtOrAfter(1, 1), true)
})

test('synchronizer predicts ahead with bounded adaptive lead', () =>
{
    const sync = new TickSynchronizer()
    sync.observeState(1000, 1000)
    assert.equal(sync.commandLeadTicks, 8)
    assert.equal(sync.estimateServerTick(1050), 1003)
    assert.equal(sync.desiredPredictionTick(1050), 1011)
    assert.equal(sync.interpolationTick(1050), 997)

    sync.recordSent(7, 1008, 1000)
    sync.acknowledge(7, 1008, 1150)
    assert.ok(sync.rttMs >= 149 && sync.rttMs <= 151)
    assert.ok(sync.commandLeadTicks >= 8)
    assert.ok(sync.commandLeadTicks <= 18)
})

test('stable low RTT decreases lead slowly and never below four', () =>
{
    const sync = new TickSynchronizer({ initialLeadTicks: 12 })
    sync.observeState(500, 0)
    for(let sequence = 1; sequence <= 40; sequence++)
    {
        const sent = sequence * 100
        sync.recordSent(sequence, 500 + sequence, sent)
        sync.acknowledge(sequence, 500 + sequence, sent + 20)
    }
    assert.ok(sync.commandLeadTicks >= 4)
    assert.ok(sync.commandLeadTicks < 12)
})

test('late acknowledgement increases lead immediately but keeps it bounded', () =>
{
    const sync = new TickSynchronizer({ initialLeadTicks: 4 })
    sync.observeState(100, 0)
    sync.recordSent(1, 110, 10)
    sync.acknowledge(1, 113, 30)
    assert.equal(sync.lateAcks, 1)
    assert.ok(sync.commandLeadTicks > 4)
    assert.ok(sync.commandLeadTicks <= 18)
})

test('clock discontinuities are counted across uint32 wrap safely', () =>
{
    const sync = new TickSynchronizer({ clockDiscontinuityTicks: 30 })
    sync.observeState(0xfffffff0, 0)
    sync.observeState(0x00000010, 1000 / 60)
    assert.equal(sync.clockDiscontinuities, 1)
})
