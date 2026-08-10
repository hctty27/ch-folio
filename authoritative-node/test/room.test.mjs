import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MAX_CATCH_UP_TICKS,
    TICK_RATE_HZ,
    TickScheduler,
} from '../src/TickScheduler.js'
import { RoomRegistry } from '../src/RoomRegistry.js'

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
