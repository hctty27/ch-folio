import { RoomSimulation as RoomSimulationBase } from './RoomSimulationBase.js'

function tickDelta(left, right)
{
    return ((Number(left) >>> 0) - (Number(right) >>> 0)) | 0
}

function diagnosticsTarget(target)
{
    if(target === undefined || target === null)
        return {}
    if(typeof target !== 'object')
        throw new TypeError('input queue diagnostics target must be an object')
    return target
}

export class RoomSimulation extends RoomSimulationBase
{
    inputQueueDiagnostics(target = null)
    {
        let futureInputCount = 0
        let futureLeadMaxTicks = 0
        let staleInputCount = 0

        for(const slot of this.slots)
        {
            if(!slot)
                continue

            const baselineTick = slot.lastConsumedInputTick === null
                ? this.currentTick >>> 0
                : slot.lastConsumedInputTick >>> 0

            for(const queuedTick of slot.queuedInputs.keys())
            {
                const leadTicks = tickDelta(queuedTick, baselineTick)
                if(leadTicks > 0)
                {
                    futureInputCount++
                    futureLeadMaxTicks = Math.max(futureLeadMaxTicks, leadTicks)
                }
                else
                    staleInputCount++
            }
        }

        const diagnostics = diagnosticsTarget(target)
        diagnostics.futureInputCount = futureInputCount
        diagnostics.futureLeadMaxTicks = futureLeadMaxTicks
        diagnostics.staleInputCount = staleInputCount
        diagnostics.lateInputCount = this.lateInputCount
        return diagnostics
    }
}

export {
    GRACE_TICKS,
    INPUT_BUFFER_TICKS,
    MAX_SLOTS,
    NO_SPAWN_INDEX,
    ROOM_EVENT_TYPES,
    ROOM_SLOT_STATES,
    SPAWN_CHECK_INTERVAL_TICKS,
} from './RoomSimulationBase.js'
