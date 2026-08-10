import assert from 'node:assert/strict'
import test from 'node:test'

import { runNodeAuthoritativeBenchmark } from '../src/benchmark.js'
import {
    AUTHORITATIVE_WARMUP_TICKS,
    runAuthoritativeWarmup,
} from '../src/warmup.js'
import { startAuthoritativeNode } from '../src/startup.js'

test('authoritative startup warmup is fixed at 600 ticks and advances eight vehicles exactly', () =>
{
    assert.equal(AUTHORITATIVE_WARMUP_TICKS, 600)

    const report = runAuthoritativeWarmup({ ticks: 6 })
    assert.deepEqual(report, {
        ticks: 6,
        finalTick: 6,
        vehicles: 8,
    })
    assert.throws(() => runAuthoritativeWarmup({ ticks: 0 }), /positive safe integer/u)
})

test('production Node benchmark warms the same runtime before measuring exact ticks', async () =>
{
    const report = await runNodeAuthoritativeBenchmark({
        warmupTicks: 6,
        ticks: 120,
    })

    assert.equal(report.metadata.productionWarmupTicks, 6)
    assert.equal(report.metadata.ticks, 120)
    assert.equal(report.phases.totalTick.count, 120)
    assert.equal(report.divergence.persistent, 0)
})

test('startup completes warmup before creating or listening on the HTTP/WebSocket service', async () =>
{
    const events = []
    const service = {
        async start()
        {
            events.push('listen')
        },
        async stop() {},
    }

    const result = await startAuthoritativeNode({
        config: { host: '127.0.0.1', port: 0 },
        warmup: async () =>
        {
            events.push('warmup')
            return { ticks: 600, finalTick: 600, vehicles: 8 }
        },
        createServer: () =>
        {
            events.push('create')
            return service
        },
    })

    assert.deepEqual(events, [ 'warmup', 'create', 'listen' ])
    assert.equal(result.service, service)
    assert.equal(result.warmup.ticks, 600)
})

test('startup fails closed when warmup fails and never creates a listener', async () =>
{
    let created = false
    await assert.rejects(
        startAuthoritativeNode({
            config: {},
            warmup: async () =>
            {
                throw new Error('warmup failed')
            },
            createServer: () =>
            {
                created = true
                throw new Error('must not create server')
            },
        }),
        /warmup failed/u,
    )
    assert.equal(created, false)
})
