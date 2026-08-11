import { Metrics as MetricsBase } from './MetricsBase.js'

const BENCHMARK_TICKS = 36_000
const PERSISTENT_GROWTH_TICKS = 60

function nonNegativeInteger(value, label)
{
    if(!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${label} must be a non-negative safe integer`)
    return value
}

function maximum(samples, field)
{
    return samples.reduce(
        (current, sample) => Math.max(current, sample[field]),
        0,
    )
}

function hasPersistentGrowth(samples)
{
    let growthTransitions = 0
    for(let index = samples.length - 1; index > 0; index--)
    {
        if(samples[index].futureInputCount <= samples[index - 1].futureInputCount)
            break
        growthTransitions++
        if(growthTransitions >= PERSISTENT_GROWTH_TICKS)
            return true
    }
    return false
}

function queueGauges(samples, lateInputBaseline)
{
    const current = samples.at(-1) ?? {
        futureInputCount: 0,
        futureLeadMaxTicks: 0,
        staleInputCount: 0,
        lateInputCount: lateInputBaseline,
    }
    const lateInputs = Math.max(0, current.lateInputCount - lateInputBaseline)
    return {
        futureInputCount: current.futureInputCount,
        futureInputCountMax: maximum(samples, 'futureInputCount'),
        futureLeadMaxTicks: maximum(samples, 'futureLeadMaxTicks'),
        staleInputMax: maximum(samples, 'staleInputCount'),
        lateInputCount: current.lateInputCount,
        lateInputRate: samples.length === 0 ? 0 : lateInputs / samples.length,
        persistentFutureQueueGrowth: hasPersistentGrowth(samples),
    }
}

export class Metrics extends MetricsBase
{
    recordInputQueueDiagnostics(value)
    {
        const diagnostics = {
            futureInputCount: nonNegativeInteger(
                value?.futureInputCount,
                'futureInputCount',
            ),
            futureLeadMaxTicks: nonNegativeInteger(
                value?.futureLeadMaxTicks,
                'futureLeadMaxTicks',
            ),
            staleInputCount: nonNegativeInteger(
                value?.staleInputCount,
                'staleInputCount',
            ),
            lateInputCount: nonNegativeInteger(
                value?.lateInputCount,
                'lateInputCount',
            ),
        }
        if(diagnostics.lateInputCount < this.inputQueueDiagnostics.lateInputCount)
            throw new RangeError('lateInputCount must not decrease')

        this.inputQueueDiagnosticsEnabled = true
        this.inputQueueDiagnostics = diagnostics
        return diagnostics
    }

    completeTick(tick)
    {
        const enabled = this.inputQueueDiagnosticsEnabled
        const sample = enabled ? { ...this.inputQueueDiagnostics } : null
        const windowSamples = enabled
            ? [ ...this.windowInputQueueSamples, sample ]
            : null
        const windowLateInputBaseline = this.windowLateInputBaseline
        const summary = super.completeTick(tick)

        if(!enabled)
            return summary

        this.benchmarkInputQueueSamples.push(sample)
        if(this.benchmarkInputQueueSamples.length > BENCHMARK_TICKS)
        {
            const removed = this.benchmarkInputQueueSamples.shift()
            this.benchmarkLateInputBaseline = removed.lateInputCount
        }

        if(summary)
            Object.assign(summary.gauges, queueGauges(windowSamples, windowLateInputBaseline))
        else
            this.windowInputQueueSamples.push(sample)
        return summary
    }

    readBenchmarkSummary()
    {
        const summary = super.readBenchmarkSummary()
        if(this.inputQueueDiagnosticsEnabled)
        {
            Object.assign(
                summary.gauges,
                queueGauges(
                    this.benchmarkInputQueueSamples,
                    this.benchmarkLateInputBaseline,
                ),
            )
        }
        return summary
    }

    reset()
    {
        super.reset()
        this.inputQueueDiagnosticsEnabled = false
        this.inputQueueDiagnostics = {
            futureInputCount: 0,
            futureLeadMaxTicks: 0,
            staleInputCount: 0,
            lateInputCount: 0,
        }
        this.benchmarkInputQueueSamples = []
        this.benchmarkLateInputBaseline = 0
        this.windowInputQueueSamples = []
        this.windowLateInputBaseline = 0
    }

    resetWindow()
    {
        super.resetWindow()
        this.windowInputQueueSamples = []
        this.windowLateInputBaseline = this.inputQueueDiagnostics?.lateInputCount ?? 0
    }
}
