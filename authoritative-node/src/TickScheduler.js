export const TICK_RATE_HZ = 60
export const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ
export const MAX_CATCH_UP_TICKS = 3

const DEADLINE_TICK_EPSILON = 1e-9
const defaultClock = {
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
}

export class TickScheduler
{
    constructor({ onTick, onCallback, clock = defaultClock } = {})
    {
        if(typeof onTick !== 'function')
            throw new TypeError('onTick must be a function')
        if(onCallback !== undefined && typeof onCallback !== 'function')
            throw new TypeError('onCallback must be a function when provided')

        this.onTick = onTick
        this.onCallback = onCallback ?? null
        this.clock = clock
        this.timer = null
        this.epochMs = 0
        this.completedTicks = 0
        this.isRunning = false
    }

    get running()
    {
        return this.isRunning
    }

    start()
    {
        if(this.isRunning)
            return false
        this.isRunning = true
        this.epochMs = this.clock.now()
        this.completedTicks = 0
        this.scheduleNext()
        return true
    }

    stop()
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

    deadlineForTick(tick)
    {
        const elapsedMs = tick * 1000 / TICK_RATE_HZ
        return this.epochMs + Math.ceil(elapsedMs - DEADLINE_TICK_EPSILON)
    }

    scheduleNext()
    {
        if(!this.isRunning)
            return
        const deadlineMs = this.deadlineForTick(this.completedTicks + 1)
        const delayMs = Math.max(0, deadlineMs - this.clock.now())
        this.timer = this.clock.setTimeout(() => this.runCallback(), delayMs)
    }

    runCallback()
    {
        this.timer = null
        if(!this.isRunning)
            return

        const elapsedMs = Math.max(0, this.clock.now() - this.epochMs)
        const elapsedTicks = elapsedMs * TICK_RATE_HZ / 1000
        const dueThroughNow = Math.max(
            this.completedTicks + 1,
            Math.floor(elapsedTicks + DEADLINE_TICK_EPSILON),
        )
        const dueTicks = dueThroughNow - this.completedTicks
        const executedTicks = Math.min(dueTicks, MAX_CATCH_UP_TICKS)
        this.onCallback?.(dueTicks, executedTicks)

        for(let index = 0; index < executedTicks && this.isRunning; index++)
        {
            this.onTick()
            this.completedTicks++
        }
        this.scheduleNext()
    }
}
