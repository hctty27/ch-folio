import type { Metrics } from './Metrics'

export const TICK_RATE_HZ = 60
export const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ
export const MAX_CATCH_UP_TICKS = 3

export interface TickSchedulerClock
{
    now(): number
    setTimeout(callback: () => void, delayMs: number): unknown
    clearTimeout(handle: unknown): void
}

type TickSchedulerOptions = {
    onTick: () => void
    metrics?: Metrics
    clock?: TickSchedulerClock
}

const defaultClock: TickSchedulerClock = {
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
    {
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
}

export class TickScheduler
{
    private readonly onTick: () => void
    private readonly metrics?: Metrics
    private readonly clock: TickSchedulerClock
    private timer: unknown = null
    private nextDeadlineMs = 0
    private isRunning = false

    constructor({ onTick, metrics, clock = defaultClock }: TickSchedulerOptions)
    {
        if(typeof onTick !== 'function')
            throw new TypeError('onTick must be a function')

        this.onTick = onTick
        this.metrics = metrics
        this.clock = clock
    }

    get running(): boolean
    {
        return this.isRunning
    }

    start(): boolean
    {
        if(this.isRunning)
            return false

        this.isRunning = true
        this.nextDeadlineMs = this.clock.now() + TICK_INTERVAL_MS
        this.scheduleNext()
        return true
    }

    stop(): boolean
    {
        if(!this.isRunning)
            return false

        this.isRunning = false
        if(this.timer !== null)
        {
            this.clock.clearTimeout(this.timer)
            this.timer = null
        }
        return true
    }

    private scheduleNext(): void
    {
        if(!this.isRunning)
            return

        const delayMs = Math.max(0, this.nextDeadlineMs - this.clock.now())
        this.timer = this.clock.setTimeout(() => this.runCallback(), delayMs)
    }

    private runCallback(): void
    {
        this.timer = null
        if(!this.isRunning)
            return

        const nowMs = this.clock.now()
        const overdueMs = Math.max(0, nowMs - this.nextDeadlineMs)
        const dueTicks = 1 + Math.floor(overdueMs / TICK_INTERVAL_MS)
        const executedTicks = Math.min(dueTicks, MAX_CATCH_UP_TICKS)

        this.metrics?.recordSchedulerCallback(dueTicks, executedTicks)

        for(let index = 0; index < executedTicks && this.isRunning; index++)
        {
            this.onTick()
            this.nextDeadlineMs += TICK_INTERVAL_MS
        }

        this.scheduleNext()
    }
}
