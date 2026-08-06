export type MetricPhaseSummary = {
    count: number
    totalMs: number
    meanMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
}

export type SchedulerMetrics = {
    callbacks: number
    catchUpTicks: number
    overloadCallbacks: number
    maxDueTicks: number
}

export type MetricsSummary = {
    startTick: number
    endTick: number
    ticks: number
    phases: Record<string, MetricPhaseSummary>
    scheduler: SchedulerMetrics
    gauges: {
        queueDepth: number
        maxQueueDepth: number
        slots: number
        maxSlots: number
    }
}

const SUMMARY_TICKS = 600

function finiteNonNegative(value: number, label: string): number
{
    if(!Number.isFinite(value) || value < 0)
        throw new RangeError(`${label} must be a finite non-negative number`)
    return value
}

function nonNegativeInteger(value: number, label: string): number
{
    if(!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${label} must be a non-negative safe integer`)
    return value
}

function percentile(sorted: readonly number[], ratio: number): number
{
    if(sorted.length === 0)
        return 0

    const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)
    return sorted[index]
}

function summarize(values: readonly number[]): MetricPhaseSummary
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
    private phases = new Map<string, number[]>()
    private windowStartTick: number | null = null
    private scheduler: SchedulerMetrics = this.emptyScheduler()
    private queueDepth = 0
    private maxQueueDepth = 0
    private slots = 0
    private maxSlots = 0

    recordPhase(name: string, milliseconds: number): void
    {
        if(typeof name !== 'string' || name.length === 0)
            throw new TypeError('metric phase name must be a non-empty string')

        const value = finiteNonNegative(milliseconds, 'milliseconds')
        const samples = this.phases.get(name) ?? []
        samples.push(value)
        this.phases.set(name, samples)
    }

    recordSchedulerCallback(dueTicks: number, executedTicks: number): void
    {
        const due = nonNegativeInteger(dueTicks, 'dueTicks')
        const executed = nonNegativeInteger(executedTicks, 'executedTicks')
        if(executed > due)
            throw new RangeError('executedTicks cannot exceed dueTicks')

        this.scheduler.callbacks++
        this.scheduler.catchUpTicks += Math.max(0, executed - 1)
        if(due > executed)
            this.scheduler.overloadCallbacks++
        this.scheduler.maxDueTicks = Math.max(this.scheduler.maxDueTicks, due)
    }

    readScheduler(): SchedulerMetrics
    {
        return { ...this.scheduler }
    }

    recordQueueDepth(depth: number): void
    {
        this.queueDepth = nonNegativeInteger(depth, 'queueDepth')
        this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queueDepth)
    }

    setSlots(slots: number): void
    {
        this.slots = nonNegativeInteger(slots, 'slots')
        this.maxSlots = Math.max(this.maxSlots, this.slots)
    }

    completeTick(tick: number): MetricsSummary | null
    {
        const currentTick = nonNegativeInteger(tick, 'tick')
        if(this.windowStartTick === null)
            this.windowStartTick = currentTick

        const ticks = currentTick - this.windowStartTick + 1
        if(ticks < SUMMARY_TICKS)
            return null

        const phases: Record<string, MetricPhaseSummary> = {}
        for(const [ name, samples ] of [ ...this.phases.entries() ]
            .sort(([ left ], [ right ]) => left.localeCompare(right)))
            phases[name] = summarize(samples)

        const summary: MetricsSummary = {
            startTick: this.windowStartTick,
            endTick: currentTick,
            ticks,
            phases,
            scheduler: this.readScheduler(),
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

    private emptyScheduler(): SchedulerMetrics
    {
        return {
            callbacks: 0,
            catchUpTicks: 0,
            overloadCallbacks: 0,
            maxDueTicks: 0,
        }
    }

    private resetWindow(): void
    {
        this.phases = new Map()
        this.windowStartTick = null
        this.scheduler = this.emptyScheduler()
        this.maxQueueDepth = this.queueDepth
        this.maxSlots = this.slots
    }
}
