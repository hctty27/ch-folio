import {
    createQuantizedInputFromPlayer,
    encodeInputBatch,
    quantizeInput,
} from '@ch-folio/authoritative-physics'

const MAX_BATCH_INPUTS = 6
const FLUSH_INTERVAL_TICKS = 3
const MAX_UNACKNOWLEDGED_INPUTS = 60
const SAFE_SUSPENSIONS = Object.freeze([ 'low', 'low', 'low', 'low' ])

function uint32(value)
{
    return Number(value) >>> 0
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

export class InputPublisher
{
    constructor(game, {
        isActive = () => false,
        recordPredictionInput = () => {},
        sendFrame = () => false,
    } = {})
    {
        if(typeof isActive !== 'function')
            throw new TypeError('isActive must be a function')
        if(typeof recordPredictionInput !== 'function')
            throw new TypeError('recordPredictionInput must be a function')
        if(typeof sendFrame !== 'function')
            throw new TypeError('sendFrame must be a function')

        this.game = game
        this.isActive = isActive
        this.recordPredictionInput = recordPredictionInput
        this.sendFrame = sendFrame
        this.sequence = 0
        this.samplesSinceFlush = 0
        this.pendingInputs = []
        this.unacknowledgedInputs = []
    }

    sample(tick)
    {
        const clientTick = uint32(tick)
        const sequence = this.sequence
        this.sequence = (this.sequence + 1) >>> 0

        const player = this.game?.player
        const input = this.isActive()
            ? createQuantizedInputFromPlayer(player, clientTick, sequence)
            : safeInput(clientTick, sequence)

        this.recordPredictionInput(input)
        this.pendingInputs.push(input)
        this.unacknowledgedInputs.push(input)

        if(this.pendingInputs.length > MAX_UNACKNOWLEDGED_INPUTS)
            this.pendingInputs.splice(0, this.pendingInputs.length - MAX_UNACKNOWLEDGED_INPUTS)
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

    flush()
    {
        if(this.pendingInputs.length === 0)
            return false

        const count = Math.min(MAX_BATCH_INPUTS, this.pendingInputs.length)
        const batch = this.pendingInputs.slice(0, count)
        const sent = this.sendFrame(encodeInputBatch(batch)) === true
        if(sent)
            this.pendingInputs.splice(0, count)
        return sent
    }
}
