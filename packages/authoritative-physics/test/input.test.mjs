import assert from 'node:assert/strict'
import test from 'node:test'

import {
    dequantizeInput,
    packSuspensions,
    quantizeInput,
    resolveMissingInput,
    unpackSuspensions,
} from '../src/index.js'

const LOW_SUSPENSIONS = [ 'low', 'low', 'low', 'low' ]

test('input quantization saturates and round-trips deterministic fields', () =>
{
    const quantized = quantizeInput({
        clientTick: 12,
        sequence: 9,
        throttle: -2,
        brake: 2,
        steering: 0.5,
        suspensions: [ 'low', 'mid', 'high', 'low' ],
        boosting: true,
        honking: false,
    })

    assert.deepEqual(quantized, {
        clientTick: 12,
        sequence: 9,
        throttle: 0,
        brake: 255,
        steering: 16384,
        suspensions: 36,
        flags: 1,
    })

    const dequantized = dequantizeInput(quantized)
    assert.equal(dequantized.clientTick, 12)
    assert.equal(dequantized.sequence, 9)
    assert.equal(dequantized.throttle, -1)
    assert.equal(dequantized.brake, 1)
    assert.equal(dequantized.steering, 16384 / 32767)
    assert.deepEqual(dequantized.suspensions, [ 'low', 'mid', 'high', 'low' ])
    assert.equal(dequantized.boosting, true)
    assert.equal(dequantized.honking, false)
})

test('suspension states use two bits per wheel in physical wheel order', () =>
{
    const packed = packSuspensions([ 'low', 'mid', 'high', 'low' ])

    assert.equal(packed, 36)
    assert.deepEqual(unpackSuspensions(packed), [ 'low', 'mid', 'high', 'low' ])
})

test('missing input holds through age six then reaches safe input at age twelve', () =>
{
    const last = quantizeInput({
        clientTick: 10,
        sequence: 10,
        throttle: 1,
        brake: 0,
        steering: 1,
        suspensions: LOW_SUSPENSIONS,
        boosting: false,
        honking: false,
    })

    const held = resolveMissingInput(last, 16)
    assert.notEqual(held, last)
    assert.deepEqual(held, last)

    const rampStart = resolveMissingInput(last, 17)
    assert.equal(rampStart.throttle, 128)
    assert.equal(rampStart.steering, 27306)
    assert.equal(rampStart.brake, 43)

    const rampEnd = resolveMissingInput(last, 22)
    assert.equal(rampEnd.throttle, 128)
    assert.equal(rampEnd.steering, 0)
    assert.equal(rampEnd.brake, 255)

    const safe = resolveMissingInput({ ...last, suspensions: 255, flags: 3 }, 23)
    assert.deepEqual(safe, {
        clientTick: 10,
        sequence: 10,
        throttle: 128,
        brake: 255,
        steering: 0,
        suspensions: 0,
        flags: 0,
    })
})

test('fallback steering ramps negative values toward zero without changing the source', () =>
{
    const last = {
        clientTick: 100,
        sequence: 7,
        throttle: 255,
        brake: 60,
        steering: -30000,
        suspensions: 85,
        flags: 2,
    }
    const source = { ...last }

    const resolved = resolveMissingInput(last, 109)

    assert.equal(resolved.throttle, 128)
    assert.equal(resolved.steering, -15000)
    assert.equal(resolved.brake, 158)
    assert.equal(resolved.suspensions, 85)
    assert.equal(resolved.flags, 2)
    assert.deepEqual(last, source)
})
