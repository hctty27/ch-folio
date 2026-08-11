import {
    INPUT_BUFFER_TICKS,
    createQuantizedInputFromPlayer,
    encodeInputBatch,
    quantizeInput,
} from '@ch-folio/authoritative-physics'
import {
    tickAdd,
    tickAtOrAfter,
} from './TickMath.js'

const MAX_BATCH_INPUTS = 6
const FLUSH_INTERVAL_TICKS = 3
const MAX_UNACKNOWLEDGED_INPUTS = 60
const SAFE_SUSPENSIONS = Object.freeze([ 'low', 'low', 'low', 'low' ])

function uint32(value)
{
    return Number(value) >>> 0
}

function defaultNow()
{
    return globalThis.performance?.now?.() ?? Date.now()
}

function safeInput(tick, sequence)
{
    return quantizeInput({
        clientTick: tick,
        sequence,
        throttle: 0,
        brake: 1,
        steering: 0,
        suspensions: SAFE_SUSPENSIONS,
        boosting: false,
        honking: false,
    })
}

export function commandTickForPredictionTick(predictionTick)
{
    return tickAdd(predictionTick, -INPUT_BUFFER_TICKS)
}

export class InputPublisher
{
    constructor(game, {
        entityOrder = null,
        isActive = () => false,
        recordPredictionInput = () => {},
        onBatchSent = () => {},
        sendFrame = () => false,
        now = defaultNow,
    } = {})
    {
        if(
            entityOrder !== null
            && (!Number.isInteger(entityOrder) || entityOrder < 1 || entityOrder > 8)
        )
            throw new TypeError('entityOrder must be null or an integer from 1 to 8')
        if(typeof isActive !== 'function')
            throw new TypeError('isActive must be a function')
        if(typeof recordPredictionInput !== 'function')
            throw new TypeError('recordPredictionInput must be a function')
        if(typeof onBatchSent !== 'function')
            throw new TypeError('onBatchSent must be a function')
        if(typeof sendFrame !== 'function')
            throw new TypeError('sendFrame must be a function')
        if(typeof now !== 'function')
            throw new TypeError('now must be a function')

        this.game = game
        this.entityOrder = entityOrder
        this.isActive = isActive
        this.recordPredictionInput = recordPredictionInput
        this.onBatchSent = onBatchSent
        this.sendFrame = sendFrame
        this.now = now
        this.sequence = 0
        this.samplesSinceFlush = 0
        this.pendingInputs = []
        this.pendingRecords = []
        this.unacknowledgedInputs = []
    }

    sample(predictionTick)
    {
        const physicalTick = uint32(predictionTick)
        const commandTick = commandTickForPredictionTick(physicalTick)
        const sequence = this.sequence
        this.sequence = (this.sequence + 1) >>> 0

        const player = this.game?.player
        const input = this.isActive()
            ? createQuantizedInputFromPlayer(player, commandTick, sequence)
            : safeInput(commandTick, sequence)
        const record = {
            predictionTick: physicalTick,
            entityOrder: this.entityOrder,
            input,
        }

        this.recordPredictionInput(record)
        this.pendingInputs.push(input)
        this.pendingRecords.push(record)
        this.unacknowledgedInputs.push(input)

        if(this.pendingInputs.length > MAX_UNACKNOWLEDGED_INPUTS)
        {
            const removeCount = this.pendingInputs.length - MAX_UNACKNOWLEDGED_INPUTS
            this.pendingInputs.splice(0, removeCount)
            this.pendingRecords.splice(0, removeCount)
        }
        if(this.unacknowledgedInputs.length > MAX_UNACKNOWLEDGED_INPUTS)
        {
            this.unacknowledgedInputs.splice(
                0,
                this.unacknowledgedInputs.length - MAX_UNACKNOWLEDGED_INPUTS,
            )
        }

        this.samplesSinceFlush++
        if(
            this.samplesSinceFlush >= FLUSH_INTERVAL_TICKS
            || this.pendingInputs.length >= MAX_BATCH_INPUTS
        )
        {
            this.samplesSinceFlush = 0
            this.flush()
        }

        return input
    }

    acknowledge(nextUnacknowledgedSequence)
    {
        const cursor = uint32(nextUnacknowledgedSequence)
        const before = this.unacknowledgedInputs.length
        this.unacknowledgedInputs = this.unacknowledgedInputs.filter(
            (input) => tickAtOrAfter(input.sequence, cursor),
        )
        this.pendingInputs = this.pendingInputs.filter(
            (input) => tickAtOrAfter(input.sequence, cursor),
        )
        this.pendingRecords = this.pendingRecords.filter(
            (record) => tickAtOrAfter(record.input.sequence, cursor),
        )
        return before - this.unacknowledgedInputs.length
    }

    flush()
    {
        if(this.pendingInputs.length === 0)
            return false

        const count = Math.min(MAX_BATCH_INPUTS, this.pendingInputs.length)
        const batch = this.pendingInputs.slice(0, count)
        const records = this.pendingRecords.slice(0, count)
        const sent = this.sendFrame(encodeInputBatch(batch)) === true
        if(sent)
        {
            this.pendingInputs.splice(0, count)
            this.pendingRecords.splice(0, count)
            this.onBatchSent(records, this.now())
        }
        return sent
    }
}
