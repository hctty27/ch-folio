const SUMMARY_TICKS = 600
const BENCHMARK_TICKS = 36_000
const SLOW_TICK_LIMIT = 8

function finiteNonNegative(value, label)
{
    if(!Number.isFinite(value) || value < 0)
        throw new RangeError(`${label} must be a finite non-negative number`)
    return value
}

function nonNegativeInteger(value, label)
{
    if(!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${label} must be a non-negative safe integer`)
    return value
}

function percentile(sorted, ratio)
{
    if(sorted.length === 0)
        return 0
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function summarize(values)
{
    const sorted = [ ...values ].sort((left, right) => left - right)
    const totalMs = sorted.reduce((total, value) => total + value, 0)
    return {
        count: sorted.length,
        totalMs,
        meanMs: sorted.length === 0 ? 0 : totalMs / sorted.length,
        p50Ms: percentile(sorted, 0.50),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted.at(-1) ?? 0,
    }
}

export class Metrics
{
    constructor()
    {
        this.reset()
    }

    recordPhase(name, milliseconds)
    {
        if(typeof name !== 'string' || name.length === 0)
            throw new TypeError('metric phase name must be a non-empty string')

        const value = finiteNonNegative(milliseconds, 'milliseconds')
        const samples = this.phases.get(name) ?? []
        samples.push(value)
        this.phases.set(name, samples)
        this.benchmarkPendingPhases.set(
            name,
            (this.benchmarkPendingPhases.get(name) ?? 0) + value,
        )
    }

    recordSchedulerCallback(dueTicks, executedTicks)
    {
        const due = nonNegativeInteger(dueTicks, 'dueTicks')
        const executed = nonNegativeInteger(executedTicks, 'executedTicks')
        if(executed > due)
            throw new RangeError('executedTicks cannot exceed dueTicks')

        this.updateScheduler(this.scheduler, due, executed)
        this.updateScheduler(this.benchmarkScheduler, due, executed)
    }

    recordQueueDepth(depth)
    {
        this.queueDepth = nonNegativeInteger(depth, 'queueDepth')
        this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queueDepth)
        this.benchmarkMaxQueueDepth = Math.max(
            this.benchmarkMaxQueueDepth,
            this.queueDepth,
        )
    }

    setSlots(slots)
    {
        this.slots = nonNegativeInteger(slots, 'slots')
        this.maxSlots = Math.max(this.maxSlots, this.slots)
        this.benchmarkMaxSlots = Math.max(this.benchmarkMaxSlots, this.slots)
    }

    recordDisconnect()
    {
        this.benchmarkDisconnects++
    }

    completeTick(tick)
    {
        const currentTick = nonNegativeInteger(tick, 'tick')
        this.completeBenchmarkTick(currentTick)

        if(this.windowStartTick === null)
            this.windowStartTick = currentTick

        const ticks = currentTick - this.windowStartTick + 1
        if(ticks < SUMMARY_TICKS)
            return null

        const phases = Object.fromEntries([ ...this.phases.entries() ]
            .sort(([ left ], [ right ]) => left.localeCompare(right))
            .map(([ name, samples ]) => [ name, summarize(samples) ]))
        const summary = {
            startTick: this.windowStartTick,
            endTick: currentTick,
            ticks,
            phases,
            scheduler: { ...this.scheduler },
            gauges: {
                queueDepth: this.queueDepth,
                maxQueueDepth: this.maxQueueDepth,
                slots: this.slots,
                maxSlots: this.maxSlots,
            },
        }
        this.resetWindow()
        return summary
    }

    readBenchmarkSummary()
    {
        const phaseEntries = [ ...this.benchmarkPhases.entries() ]
            .sort(([ left ], [ right ]) => left.localeCompare(right))
        const phases = Object.fromEntries(phaseEntries
            .map(([ name, samples ]) => [ name, summarize(samples) ]))
        return {
            startTick: this.benchmarkTicks[0] ?? 0,
            endTick: this.benchmarkTicks.at(-1) ?? 0,
            ticks: this.benchmarkTicks.length,
            phases,
            slowTicks: this.readSlowTicks(phaseEntries),
            scheduler: { ...this.benchmarkScheduler },
            gauges: {
                queueDepth: this.queueDepth,
                maxQueueDepth: this.benchmarkMaxQueueDepth,
                slots: this.slots,
                maxSlots: this.benchmarkMaxSlots,
            },
            disconnects: this.benchmarkDisconnects,
        }
    }

    readSlowTicks(phaseEntries)
    {
        const totalSamples = this.benchmarkPhases.get('totalTick') ?? []
        return this.benchmarkTicks
            .map((tick, index) => ({
                tick,
                index,
                totalMs: totalSamples[index] ?? 0,
            }))
            .sort((left, right) => right.totalMs - left.totalMs || right.tick - left.tick)
            .slice(0, SLOW_TICK_LIMIT)
            .map(({ tick, index, totalMs }) => ({
                tick,
                totalMs,
                phases: Object.fromEntries(phaseEntries.map(([ name, samples ]) => [
                    name,
                    samples[index] ?? 0,
                ])),
            }))
    }

    reset()
    {
        this.phases = new Map()
        this.windowStartTick = null
        this.scheduler = this.emptyScheduler()
        this.queueDepth = 0
        this.maxQueueDepth = 0
        this.slots = 0
        this.maxSlots = 0
        this.benchmarkTicks = []
        this.benchmarkPhases = new Map()
        this.benchmarkPendingPhases = new Map()
        this.benchmarkScheduler = this.emptyScheduler()
        this.benchmarkMaxQueueDepth = 0
        this.benchmarkMaxSlots = 0
        this.benchmarkDisconnects = 0
    }

    updateScheduler(target, dueTicks, executedTicks)
    {
        target.callbacks++
        target.catchUpTicks += Math.max(0, executedTicks - 1)
        if(dueTicks > executedTicks)
            target.overloadCallbacks++
        target.maxDueTicks = Math.max(target.maxDueTicks, dueTicks)
    }

    completeBenchmarkTick(tick)
    {
        const previousTick = this.benchmarkTicks.at(-1)
        if(previousTick !== undefined && tick <= previousTick)
            throw new RangeError('benchmark ticks must be strictly increasing')

        const priorLength = this.benchmarkTicks.length
        this.benchmarkTicks.push(tick)

        for(const [ name, samples ] of this.benchmarkPhases)
            samples.push(this.benchmarkPendingPhases.get(name) ?? 0)

        for(const [ name, total ] of this.benchmarkPendingPhases)
        {
            if(this.benchmarkPhases.has(name))
                continue
            const samples = Array.from({ length: priorLength }, () => 0)
            samples.push(total)
            this.benchmarkPhases.set(name, samples)
        }
        this.benchmarkPendingPhases.clear()

        if(this.benchmarkTicks.length > BENCHMARK_TICKS)
        {
            this.benchmarkTicks.shift()
            for(const samples of this.benchmarkPhases.values())
                samples.shift()
        }
    }

    emptyScheduler()
    {
        return {
            callbacks: 0,
            catchUpTicks: 0,
            overloadCallbacks: 0,
            maxDueTicks: 0,
        }
    }

    resetWindow()
    {
        this.phases = new Map()
        this.windowStartTick = null
        this.scheduler = this.emptyScheduler()
        this.maxQueueDepth = this.queueDepth
        this.maxSlots = this.slots
    }
}
