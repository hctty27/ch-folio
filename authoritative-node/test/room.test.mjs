import assert from 'node:assert/strict'
import test from 'node:test'
import { quantizeInput } from '@ch-folio/authoritative-physics'
import { BenchmarkNodeAuthoritativeRoom } from '../src/BenchmarkNodeAuthoritativeRoom.js'
import { NodeAuthoritativeRoom } from '../src/NodeAuthoritativeRoom.js'
import {
    MAX_CATCH_UP_TICKS,
    TICK_RATE_HZ,
    TickScheduler,
} from '../src/TickScheduler.js'
import { RoomRegistry } from '../src/RoomRegistry.js'

const BENCHMARK_TOKEN = 'benchmark-token-0123456789abcdef0123456789abcdef'

class FakeClock
{
    constructor()
    {
        this.time = 0
        this.nextId = 1
        this.timers = new Map()
    }

    now = () => this.time

    setTimeout = (callback, delayMs) =>
    {
        const id = this.nextId++
        this.timers.set(id, { callback, deadline: this.time + delayMs })
        return id
    }

    clearTimeout = (id) =>
    {
        this.timers.delete(id)
    }

    advance(deltaMs)
    {
        this.time += deltaMs
        let ran
        do
        {
            ran = false
            const due = Array.from(this.timers.entries())
                .filter(([, timer ]) => timer.deadline <= this.time)
                .sort((left, right) => left[1].deadline - right[1].deadline || left[0] - right[0])
            if(due.length > 0)
            {
                const [ id, timer ] = due[0]
                this.timers.delete(id)
                timer.callback()
                ran = true
            }
        }
        while(ran)
    }
}

test('scheduler executes exactly 60 logical ticks per second without elapsed arguments', () =>
{
    const clock = new FakeClock()
    const calls = []
    const scheduler = new TickScheduler({
        clock,
        onTick: (...args) => calls.push(args),
    })

    assert.equal(TICK_RATE_HZ, 60)
    assert.equal(scheduler.start(), true)
    assert.equal(scheduler.start(), false)
    for(let millisecond = 0; millisecond < 1000; millisecond++)
        clock.advance(1)

    assert.equal(calls.length, 60)
    assert.equal(calls.every((args) => args.length === 0), true)
    assert.equal(scheduler.stop(), true)
    assert.equal(scheduler.stop(), false)
    assert.equal(clock.timers.size, 0)
})

test('scheduler caps every callback at three catch-up ticks', () =>
{
    const clock = new FakeClock()
    let ticks = 0
    const callbacks = []
    const scheduler = new TickScheduler({
        clock,
        onTick: () => ticks++,
        onCallback: (dueTicks, executedTicks) => callbacks.push({ dueTicks, executedTicks }),
    })

    scheduler.start()
    clock.advance(100)
    assert.equal(MAX_CATCH_UP_TICKS, 3)
    assert.ok(callbacks[0].dueTicks >= 6)
    assert.equal(callbacks[0].executedTicks, 3)
    assert.equal(callbacks.every(({ executedTicks }) => executedTicks <= MAX_CATCH_UP_TICKS), true)
    assert.equal(ticks, callbacks.reduce((total, callback) => total + callback.executedTicks, 0))
})

test('live room metrics record completed ticks, slot maximum, and queued input depth', async () =>
{
    const room = new NodeAuthoritativeRoom({ room: 'metrics', autoSchedule: false })
    try
    {
        room.ensureRuntime()
        const grant = await room.sessions.createSession({
            room: 'metrics',
            currentTick: room.currentTick,
        })
        assert.ok(grant)
        const reserved = room.simulation.reserveSlot({ playerId: grant.playerId })
        assert.equal(reserved.entityOrder, grant.entityOrder)
        room.simulation.markSyncReady(grant.entityOrder)

        room.advanceOneTick()
        room.advanceOneTick()
        room.advanceOneTick()

        const targetTick = room.currentTick + 3
        const queued = room.simulation.queueInput(grant.entityOrder, quantizeInput({
            clientTick: targetTick,
            sequence: 1,
            throttle: 1,
            brake: 0,
            steering: 0.25,
            suspensions: [ 'low', 'low', 'low', 'low' ],
            boosting: false,
            honking: false,
        }))
        assert.equal(queued, true)
        assert.equal(room.readQueueDepth(), 1)

        room.advanceOneTick()
        const summary = room.metrics.readBenchmarkSummary()
        assert.equal(summary.ticks, 4)
        assert.equal(summary.phases.totalTick.count, 4)
        assert.equal(summary.gauges.maxSlots, 1)
        assert.equal(summary.gauges.maxQueueDepth, 1)
        assert.equal('simulationAdvance' in summary.phases, false)
        assert.equal('rapierStep' in summary.phases, false)
        assert.equal('simulationNonRapier' in summary.phases, false)
        assert.equal('stateBroadcast' in summary.phases, false)
    }
    finally
    {
        await room.destroy()
    }
})

test('benchmark-enabled live room records tick phase breakdown without changing normal rooms', async () =>
{
    const room = new BenchmarkNodeAuthoritativeRoom({
        room: 'benchmark-phases',
        autoSchedule: false,
        benchmarkToken: BENCHMARK_TOKEN,
    })
    try
    {
        room.ensureRuntime()
        const grant = await room.sessions.createSession({
            room: room.room,
            currentTick: room.currentTick,
        })
        assert.ok(grant)
        const reserved = room.simulation.reserveSlot({ playerId: grant.playerId })
        assert.equal(reserved.entityOrder, grant.entityOrder)
        room.simulation.markSyncReady(grant.entityOrder)

        for(let tick = 0; tick < 60; tick++)
            room.advanceOneTick()

        const summary = room.metrics.readBenchmarkSummary()
        for(const phase of [
            'simulationAdvance',
            'rapierStep',
            'simulationNonRapier',
            'sessionSync',
            'graceExpiry',
            'worldHashCapture',
            'stateBroadcast',
            'cleanup',
            'queueBookkeeping',
        ])
        {
            assert.equal(summary.phases[phase].count, 60)
            assert.ok(summary.phases[phase].maxMs >= 0)
        }
        assert.ok(summary.phases.simulationAdvance.totalMs >= summary.phases.rapierStep.totalMs)
        assert.ok(summary.phases.simulationAdvance.totalMs >= summary.phases.simulationNonRapier.totalMs)
        assert.equal(summary.phases.totalTick.count, 60)
    }
    finally
    {
        await room.destroy()
    }
})

test('room registry selects benchmark timing only when a benchmark token is configured', async () =>
{
    const regularRegistry = new RoomRegistry()
    const benchmarkRegistry = new RoomRegistry({
        roomOptions: { benchmarkToken: BENCHMARK_TOKEN },
    })
    try
    {
        assert.ok(regularRegistry.getOrCreate('regular') instanceof NodeAuthoritativeRoom)
        assert.ok(
            benchmarkRegistry.getOrCreate('benchmark') instanceof BenchmarkNodeAuthoritativeRoom,
        )
    }
    finally
    {
        await regularRegistry.stop()
        await benchmarkRegistry.stop()
    }
})

test('room registry isolates rooms, removes only matching empty instances, and stops all rooms', async () =>
{
    const created = []
    const registry = new RoomRegistry({
        roomFactory: (room, onEmpty) =>
        {
            const instance = {
                room,
                empty: false,
                destroyed: false,
                get isEmpty() { return this.empty },
                async destroy() { this.destroyed = true },
                markEmpty()
                {
                    this.empty = true
                    onEmpty(this)
                },
            }
            created.push(instance)
            return instance
        },
    })

    const alpha = registry.getOrCreate('alpha')
    const sameAlpha = registry.getOrCreate('alpha')
    const beta = registry.getOrCreate('beta')
    assert.equal(alpha, sameAlpha)
    assert.notEqual(alpha, beta)
    assert.equal(registry.size, 2)
    assert.equal(registry.has('alpha'), true)

    registry.deleteIfEmpty('alpha', beta)
    assert.equal(registry.has('alpha'), true)
    alpha.markEmpty()
    assert.equal(registry.has('alpha'), false)
    assert.equal(registry.size, 1)

    await registry.stop()
    assert.equal(beta.destroyed, true)
    assert.equal(registry.size, 0)
    assert.equal(created.length, 2)
})