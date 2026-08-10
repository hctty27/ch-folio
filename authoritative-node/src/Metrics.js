import { Metrics as MetricsBase } from './MetricsBase.js'

const SUMMARY_TICKS = 600
const BENCHMARK_TICKS = 36_000
const PERSISTENT_GROWTH_TICKS = 60

function nonNegativeInteger(value, label)
{
    if(!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${label} must be a non-negative safe integer`)
    return value
}

class QueueDiagnosticsRing
{
    constructor(capacity)
    {
        this.capacity = capacity
        this.futureInputCounts = new Float64Array(capacity)
        this.futureLeadMaxTicks = new Float64Array(capacity)
        this.staleInputCounts = new Float64Array(capacity)
        this.lateInputCounts = new Float64Array(capacity)
        this.clear(0)
    }

    push(diagnostics)
    {
        let index
        if(this.length < this.capacity)
        {
            index = (this.start + this.length) % this.capacity
            this.length++
        }
        else
        {
            index = this.start
            this.lateInputBaseline = this.lateInputCounts[index]
            this.start = (this.start + 1) % this.capacity
        }

        this.futureInputCounts[index] = diagnostics.futureInputCount
        this.futureLeadMaxTicks[index] = diagnostics.futureLeadMaxTicks
        this.staleInputCounts[index] = diagnostics.staleInputCount
        this.lateInputCounts[index] = diagnostics.lateInputCount
    }

    clear(lateInputBaseline)
    {
        this.start = 0
        this.length = 0
        this.lateInputBaseline = lateInputBaseline
    }

    readGauges()
    {
        if(this.length === 0)
        {
            return {
                futureInputCount: 0,
                futureInputCountMax: 0,
                futureLeadMaxTicks: 0,
                staleInputMax: 0,
                lateInputCount: this.lateInputBaseline,
                lateInputRate: 0,
                persistentFutureQueueGrowth: false,
            }
        }

        let futureInputCountMax = 0
        let futureLeadMaxTicks = 0
        let staleInputMax = 0
        for(let offset = 0; offset < this.length; offset++)
        {
            const index = this.index(offset)
            futureInputCountMax = Math.max(
                futureInputCountMax,
                this.futureInputCounts[index],
            )
            futureLeadMaxTicks = Math.max(
                futureLeadMaxTicks,
                this.futureLeadMaxTicks[index],
            )
            staleInputMax = Math.max(
                staleInputMax,
                this.staleInputCounts[index],
            )
        }

        const latestIndex = this.index(this.length - 1)
        const lateInputCount = this.lateInputCounts[latestIndex]
        return {
            futureInputCount: this.futureInputCounts[latestIndex],
            futureInputCountMax,
            futureLeadMaxTicks,
            staleInputMax,
            lateInputCount,
            lateInputRate: Math.max(
                0,
                lateInputCount - this.lateInputBaseline,
            ) / this.length,
            persistentFutureQueueGrowth: this.hasPersistentGrowth(),
        }
    }

    hasPersistentGrowth()
    {
        let growthTransitions = 0
        for(let offset = this.length - 1; offset > 0; offset--)
        {
            if(
                this.futureInputCounts[this.index(offset)]
                <= this.futureInputCounts[this.index(offset - 1)]
            )
                break

            growthTransitions++
            if(growthTransitions >= PERSISTENT_GROWTH_TICKS)
                return true
        }
        return false
    }

    index(offset)
    {
        return (this.start + offset) % this.capacity
    }

    *[Symbol.iterator]()
    {
        for(let offset = 0; offset < this.length; offset++)
        {
            const index = this.index(offset)
            yield {
                futureInputCount: this.futureInputCounts[index],
                futureLeadMaxTicks: this.futureLeadMaxTicks[index],
                staleInputCount: this.staleInputCounts[index],
                lateInputCount: this.lateInputCounts[index],
            }
        }
    }
}

export class Metrics extends MetricsBase
{
    recordInputQueueDiagnostics(value)
    {
        const futureInputCount = nonNegativeInteger(
            value?.futureInputCount,
            'futureInputCount',
        )
        const futureLeadMaxTicks = nonNegativeInteger(
            value?.futureLeadMaxTicks,
            'futureLeadMaxTicks',
        )
        const staleInputCount = nonNegativeInteger(
            value?.staleInputCount,
            'staleInputCount',
        )
        const lateInputCount = nonNegativeInteger(
            value?.lateInputCount,
            'lateInputCount',
        )
        if(lateInputCount < this.inputQueueDiagnostics.lateInputCount)
            throw new RangeError('lateInputCount must not decrease')

        this.inputQueueDiagnosticsEnabled = true
        this.inputQueueDiagnostics.futureInputCount = futureInputCount
        this.inputQueueDiagnostics.futureLeadMaxTicks = futureLeadMaxTicks
        this.inputQueueDiagnostics.staleInputCount = staleInputCount
        this.inputQueueDiagnostics.lateInputCount = lateInputCount
        return this.inputQueueDiagnostics
    }

    completeTick(tick)
    {
        const enabled = this.inputQueueDiagnosticsEnabled
        if(enabled)
        {
            this.windowInputQueueSamples.push(this.inputQueueDiagnostics)
            this.benchmarkInputQueueSamples.push(this.inputQueueDiagnostics)
        }

        const summary = super.completeTick(tick)
        if(enabled && summary)
        {
            Object.assign(
                summary.gauges,
                this.completedWindowQueueGauges,
            )
            this.completedWindowQueueGauges = null
        }
        return summary
    }

    readBenchmarkSummary()
    {
        const summary = super.readBenchmarkSummary()
        if(this.inputQueueDiagnosticsEnabled)
        {
            Object.assign(
                summary.gauges,
                this.benchmarkInputQueueSamples.readGauges(),
            )
        }
        return summary
    }

    reset()
    {
        super.reset()
        this.inputQueueDiagnosticsEnabled = false
        this.inputQueueDiagnostics ??= {
            futureInputCount: 0,
            futureLeadMaxTicks: 0,
            staleInputCount: 0,
            lateInputCount: 0,
        }
        this.inputQueueDiagnostics.futureInputCount = 0
        this.inputQueueDiagnostics.futureLeadMaxTicks = 0
        this.inputQueueDiagnostics.staleInputCount = 0
        this.inputQueueDiagnostics.lateInputCount = 0

        this.windowInputQueueSamples ??= new QueueDiagnosticsRing(SUMMARY_TICKS)
        this.benchmarkInputQueueSamples ??= new QueueDiagnosticsRing(BENCHMARK_TICKS)
        this.windowInputQueueSamples.clear(0)
        this.benchmarkInputQueueSamples.clear(0)
        this.completedWindowQueueGauges = null
    }

    resetWindow()
    {
        this.completedWindowQueueGauges = this.inputQueueDiagnosticsEnabled
            ? this.windowInputQueueSamples.readGauges()
            : null
        super.resetWindow()
        this.windowInputQueueSamples.clear(
            this.inputQueueDiagnostics?.lateInputCount ?? 0,
        )
    }
}
