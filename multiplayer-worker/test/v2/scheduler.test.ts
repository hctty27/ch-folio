import { describe, expect, test } from 'vitest'

import { Metrics } from '../../src/v2/Metrics'
import {
    TickScheduler,
    type TickSchedulerClock,
} from '../../src/v2/TickScheduler'

type ScheduledTask = {
    id: number
    dueMs: number
    callback: () => void
}

class FakeClock implements TickSchedulerClock
{
    private currentMs = 0
    private nextId = 1
    private readonly tasks = new Map<number, ScheduledTask>()

    now(): number
    {
        return this.currentMs
    }

    setTimeout(callback: () => void, delayMs: number): number
    {
        const id = this.nextId++
        this.tasks.set(id, {
            id,
            dueMs: this.currentMs + Math.max(0, delayMs),
            callback,
        })
        return id
    }

    clearTimeout(handle: unknown): void
    {
        if(typeof handle === 'number')
            this.tasks.delete(handle)
    }

    get pendingCount(): number
    {
        return this.tasks.size
    }

    jumpBy(milliseconds: number): void
    {
        this.currentMs += milliseconds
    }

    runNext(): boolean
    {
        const next = [ ...this.tasks.values() ]
            .sort((left, right) =>
                left.dueMs - right.dueMs || left.id - right.id)[0]
        if(next === undefined || next.dueMs > this.currentMs)
            return false

        this.tasks.delete(next.id)
        next.callback()
        return true
    }

    advanceBy(milliseconds: number): void
    {
        const targetMs = this.currentMs + milliseconds

        while(true)
        {
            const next = [ ...this.tasks.values() ]
                .sort((left, right) =>
                    left.dueMs - right.dueMs || left.id - right.id)[0]
            if(next === undefined || next.dueMs > targetMs)
                break

            this.currentMs = next.dueMs
            this.tasks.delete(next.id)
            next.callback()
        }

        this.currentMs = targetMs
    }
}

describe('TickScheduler', () =>
{
    test('start is idempotent and stop cancels the pending callback', () =>
    {
        const clock = new FakeClock()
        let ticks = 0
        const scheduler = new TickScheduler({
            clock,
            onTick: () => { ticks++ },
        })

        expect(scheduler.running).toBe(false)
        expect(scheduler.start()).toBe(true)
        expect(scheduler.start()).toBe(false)
        expect(scheduler.running).toBe(true)
        expect(clock.pendingCount).toBe(1)

        clock.advanceBy(17)
        expect(ticks).toBe(1)

        expect(scheduler.stop()).toBe(true)
        expect(scheduler.stop()).toBe(false)
        expect(scheduler.running).toBe(false)
        expect(clock.pendingCount).toBe(0)

        clock.advanceBy(100)
        expect(ticks).toBe(1)
    })

    test('advances exactly sixty logical ticks per second without elapsed-time arguments', () =>
    {
        const clock = new FakeClock()
        const argumentCounts: number[] = []
        const scheduler = new TickScheduler({
            clock,
            onTick: (...args: never[]) =>
            {
                argumentCounts.push(args.length)
            },
        })

        scheduler.start()
        clock.advanceBy(1000)

        expect(argumentCounts).toHaveLength(60)
        expect(argumentCounts.every((count) => count === 0)).toBe(true)
    })

    test('caps one delayed callback at three catch-up ticks and records overload', () =>
    {
        const clock = new FakeClock()
        const metrics = new Metrics()
        let ticks = 0
        const scheduler = new TickScheduler({
            clock,
            metrics,
            onTick: () => { ticks++ },
        })

        scheduler.start()
        clock.jumpBy(100)
        expect(clock.runNext()).toBe(true)

        expect(ticks).toBe(3)
        expect(clock.pendingCount).toBe(1)
        expect(metrics.readScheduler()).toEqual({
            callbacks: 1,
            catchUpTicks: 2,
            overloadCallbacks: 1,
            maxDueTicks: 6,
        })

        while(clock.runNext())
        {
            // Drain zero-delay catch-up callbacks at the same fake time.
        }
        expect(ticks).toBe(6)
    })

    test('may stop from inside the tick callback when the final slot releases', () =>
    {
        const clock = new FakeClock()
        let slots = 1
        let ticks = 0
        let scheduler: TickScheduler

        scheduler = new TickScheduler({
            clock,
            onTick: () =>
            {
                ticks++
                slots--
                if(slots === 0)
                    scheduler.stop()
            },
        })

        scheduler.start()
        clock.advanceBy(17)

        expect(ticks).toBe(1)
        expect(scheduler.running).toBe(false)
        expect(clock.pendingCount).toBe(0)
    })
})

describe('Metrics', () =>
{
    test('summarizes phase timings and gauges every six hundred ticks', () =>
    {
        const metrics = new Metrics()

        metrics.recordPhase('decode', 1)
        metrics.recordPhase('decode', 3)
        metrics.recordPhase('encode', 2)
        metrics.recordQueueDepth(4)
        metrics.setSlots(3)

        for(let tick = 1; tick < 600; tick++)
            expect(metrics.completeTick(tick)).toBeNull()

        const summary = metrics.completeTick(600)
        expect(summary).not.toBeNull()
        expect(summary).toMatchObject({
            startTick: 1,
            endTick: 600,
            ticks: 600,
            gauges: {
                queueDepth: 4,
                maxQueueDepth: 4,
                slots: 3,
                maxSlots: 3,
            },
        })
        expect(summary!.phases.decode).toMatchObject({
            count: 2,
            totalMs: 4,
            meanMs: 2,
            p50Ms: 1,
            p95Ms: 3,
            p99Ms: 3,
            maxMs: 3,
        })
        expect(summary!.phases.encode.count).toBe(1)

        expect(metrics.completeTick(601)).toBeNull()
    })
})
