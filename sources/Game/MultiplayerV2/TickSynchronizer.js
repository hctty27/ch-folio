import {
    tickAdd,
    tickAfter,
    tickDelta,
} from './TickMath.js'

const DEFAULT_SIMULATION_HZ = 60
const DEFAULT_INITIAL_LEAD_TICKS = 8
const DEFAULT_MIN_LEAD_TICKS = 4
const DEFAULT_MAX_LEAD_TICKS = 18
const DEFAULT_SAFETY_SLACK_TICKS = 2
const DEFAULT_INTERPOLATION_DELAY_TICKS = 6
const DEFAULT_MAX_INTERPOLATION_DELAY_TICKS = 12
const DEFAULT_CLOCK_DISCONTINUITY_TICKS = 30
const DEFAULT_RTT_ALPHA = 0.125
const DEFAULT_JITTER_ALPHA = 0.25
const DEFAULT_LEAD_DECREASE_ACKS = 6
const DEFAULT_INTERPOLATION_DECREASE_ACKS = 12
const MAX_SENT_RECORDS = 256

function clamp(value, minimum, maximum)
{
    return Math.min(maximum, Math.max(minimum, value))
}

function requireFinite(value, name)
{
    const number = Number(value)
    if(!Number.isFinite(number))
        throw new TypeError(`${name} must be finite`)
    return number
}

function requirePositiveInteger(value, name)
{
    const number = requireFinite(value, name)
    if(!Number.isInteger(number) || number <= 0)
        throw new RangeError(`${name} must be a positive integer`)
    return number
}

export class TickSynchronizer
{
    constructor({
        simulationHz = DEFAULT_SIMULATION_HZ,
        initialLeadTicks = DEFAULT_INITIAL_LEAD_TICKS,
        minLeadTicks = DEFAULT_MIN_LEAD_TICKS,
        maxLeadTicks = DEFAULT_MAX_LEAD_TICKS,
        safetySlackTicks = DEFAULT_SAFETY_SLACK_TICKS,
        interpolationDelayTicks = DEFAULT_INTERPOLATION_DELAY_TICKS,
        maxInterpolationDelayTicks = DEFAULT_MAX_INTERPOLATION_DELAY_TICKS,
        clockDiscontinuityTicks = DEFAULT_CLOCK_DISCONTINUITY_TICKS,
        rttAlpha = DEFAULT_RTT_ALPHA,
        jitterAlpha = DEFAULT_JITTER_ALPHA,
        leadDecreaseAcks = DEFAULT_LEAD_DECREASE_ACKS,
        interpolationDecreaseAcks = DEFAULT_INTERPOLATION_DECREASE_ACKS,
    } = {})
    {
        this.simulationHz = requirePositiveInteger(simulationHz, 'simulationHz')
        this.tickDurationMs = 1000 / this.simulationHz
        this.minLeadTicks = requirePositiveInteger(minLeadTicks, 'minLeadTicks')
        this.maxLeadTicks = requirePositiveInteger(maxLeadTicks, 'maxLeadTicks')
        if(this.maxLeadTicks < this.minLeadTicks)
            throw new RangeError('maxLeadTicks must be >= minLeadTicks')

        this.safetySlackTicks = requirePositiveInteger(safetySlackTicks, 'safetySlackTicks')
        this.initialInterpolationDelayTicks = requirePositiveInteger(
            interpolationDelayTicks,
            'interpolationDelayTicks',
        )
        this.maxInterpolationDelayTicks = requirePositiveInteger(
            maxInterpolationDelayTicks,
            'maxInterpolationDelayTicks',
        )
        if(this.maxInterpolationDelayTicks < this.initialInterpolationDelayTicks)
        {
            throw new RangeError(
                'maxInterpolationDelayTicks must be >= interpolationDelayTicks',
            )
        }

        this.clockDiscontinuityTicks = requirePositiveInteger(
            clockDiscontinuityTicks,
            'clockDiscontinuityTicks',
        )
        this.rttAlpha = clamp(requireFinite(rttAlpha, 'rttAlpha'), 0, 1)
        this.jitterAlpha = clamp(requireFinite(jitterAlpha, 'jitterAlpha'), 0, 1)
        this.leadDecreaseAcks = requirePositiveInteger(leadDecreaseAcks, 'leadDecreaseAcks')
        this.interpolationDecreaseAcks = requirePositiveInteger(
            interpolationDecreaseAcks,
            'interpolationDecreaseAcks',
        )

        this.initialLeadTicks = clamp(
            requirePositiveInteger(initialLeadTicks, 'initialLeadTicks'),
            this.minLeadTicks,
            this.maxLeadTicks,
        )
        this._commandLeadTicks = this.initialLeadTicks
        this._interpolationDelayTicks = this.initialInterpolationDelayTicks
        this._rttMs = 0
        this._jitterMs = 0
        this._hasRtt = false
        this._lastRttSampleMs = null
        this._lateAcks = 0
        this._clockDiscontinuities = 0
        this._stableLeadAcks = 0
        this._stableInterpolationAcks = 0
        this._anchorServerTick = null
        this._anchorReceivedAtMs = null
        this._lastObservedServerTick = null
        this._sent = new Map()
    }

    get commandLeadTicks()
    {
        return this._commandLeadTicks
    }

    get rttMs()
    {
        return this._rttMs
    }

    get jitterMs()
    {
        return this._jitterMs
    }

    get lateAcks()
    {
        return this._lateAcks
    }

    get clockDiscontinuities()
    {
        return this._clockDiscontinuities
    }

    reset(serverTick, receivedAtMs)
    {
        const tick = Number(serverTick) >>> 0
        const receivedAt = requireFinite(receivedAtMs, 'receivedAtMs')
        this._commandLeadTicks = this.initialLeadTicks
        this._interpolationDelayTicks = this.initialInterpolationDelayTicks
        this._rttMs = 0
        this._jitterMs = 0
        this._hasRtt = false
        this._lastRttSampleMs = null
        this._lateAcks = 0
        this._clockDiscontinuities = 0
        this._stableLeadAcks = 0
        this._stableInterpolationAcks = 0
        this._anchorServerTick = tick
        this._anchorReceivedAtMs = receivedAt
        this._lastObservedServerTick = tick
        this._sent.clear()
        return tick
    }

    observeState(serverTick, receivedAtMs)
    {
        const tick = Number(serverTick) >>> 0
        const receivedAt = requireFinite(receivedAtMs, 'receivedAtMs')

        if(this._lastObservedServerTick !== null)
        {
            if(!tickAfter(tick, this._lastObservedServerTick))
                return false

            const expectedTick = this.estimateServerTick(receivedAt)
            if(Math.abs(tickDelta(tick, expectedTick)) > this.clockDiscontinuityTicks)
            {
                this._clockDiscontinuities++
                return false
            }
        }

        this._anchorServerTick = tick
        this._anchorReceivedAtMs = receivedAt
        this._lastObservedServerTick = tick
        return true
    }

    recordSent(sequence, commandTick, sentAtMs)
    {
        const key = Number(sequence) >>> 0
        this._sent.set(key, {
            commandTick: Number(commandTick) >>> 0,
            sentAtMs: requireFinite(sentAtMs, 'sentAtMs'),
        })

        while(this._sent.size > MAX_SENT_RECORDS)
            this._sent.delete(this._sent.keys().next().value)
    }

    acknowledge(sequence, processedServerTick, receivedAtMs)
    {
        const key = Number(sequence) >>> 0
        const sent = this._sent.get(key)
        if(sent === undefined)
            return false

        this._sent.delete(key)
        const receivedAt = requireFinite(receivedAtMs, 'receivedAtMs')
        const rttSampleMs = Math.max(0, receivedAt - sent.sentAtMs)
        this.#observeRtt(rttSampleMs)

        const latenessTicks = Math.max(
            0,
            tickDelta(Number(processedServerTick) >>> 0, sent.commandTick),
        )
        this.#updateCommandLead(latenessTicks)
        this.#updateInterpolationDelay()
        return true
    }

    estimateServerTick(nowMs)
    {
        if(this._anchorServerTick === null)
            return 0

        const now = requireFinite(nowMs, 'nowMs')
        const elapsedMs = Math.max(0, now - this._anchorReceivedAtMs)
        const elapsedTicks = Math.floor(elapsedMs / this.tickDurationMs)
        return tickAdd(this._anchorServerTick, elapsedTicks)
    }

    desiredPredictionTick(nowMs)
    {
        return tickAdd(this.estimateServerTick(nowMs), this._commandLeadTicks)
    }

    interpolationTick(nowMs)
    {
        return tickAdd(this.estimateServerTick(nowMs), -this._interpolationDelayTicks)
    }

    #observeRtt(sampleMs)
    {
        if(!this._hasRtt)
        {
            this._rttMs = sampleMs
            this._jitterMs = 0
            this._hasRtt = true
        }
        else
        {
            this._rttMs += this.rttAlpha * (sampleMs - this._rttMs)
            const deltaMs = Math.abs(sampleMs - this._lastRttSampleMs)
            this._jitterMs += this.jitterAlpha * (deltaMs - this._jitterMs)
        }
        this._lastRttSampleMs = sampleMs
    }

    #targetCommandLeadTicks()
    {
        if(!this._hasRtt)
            return this._commandLeadTicks

        const networkMarginMs = (this._rttMs * 0.5) + this._jitterMs
        const networkTicks = Math.ceil(networkMarginMs / this.tickDurationMs)
        return clamp(
            networkTicks + this.safetySlackTicks,
            this.minLeadTicks,
            this.maxLeadTicks,
        )
    }

    #updateCommandLead(latenessTicks)
    {
        const targetLeadTicks = this.#targetCommandLeadTicks()
        if(latenessTicks > 0)
        {
            this._lateAcks++
            this._commandLeadTicks = clamp(
                Math.max(
                    targetLeadTicks,
                    this._commandLeadTicks + latenessTicks,
                ),
                this.minLeadTicks,
                this.maxLeadTicks,
            )
            this._stableLeadAcks = 0
            return
        }

        if(targetLeadTicks > this._commandLeadTicks)
        {
            this._commandLeadTicks = targetLeadTicks
            this._stableLeadAcks = 0
            return
        }

        if(targetLeadTicks === this._commandLeadTicks)
        {
            this._stableLeadAcks = 0
            return
        }

        this._stableLeadAcks++
        if(this._stableLeadAcks >= this.leadDecreaseAcks)
        {
            this._commandLeadTicks = Math.max(
                targetLeadTicks,
                this._commandLeadTicks - 1,
            )
            this._stableLeadAcks = 0
        }
    }

    #updateInterpolationDelay()
    {
        const jitterTicks = Math.ceil(this._jitterMs / this.tickDurationMs)
        const targetDelayTicks = clamp(
            this.initialInterpolationDelayTicks + jitterTicks,
            this.initialInterpolationDelayTicks,
            this.maxInterpolationDelayTicks,
        )

        if(targetDelayTicks > this._interpolationDelayTicks)
        {
            this._interpolationDelayTicks++
            this._stableInterpolationAcks = 0
            return
        }

        if(targetDelayTicks === this._interpolationDelayTicks)
        {
            this._stableInterpolationAcks = 0
            return
        }

        this._stableInterpolationAcks++
        if(this._stableInterpolationAcks >= this.interpolationDecreaseAcks)
        {
            this._interpolationDelayTicks--
            this._stableInterpolationAcks = 0
        }
    }
}
