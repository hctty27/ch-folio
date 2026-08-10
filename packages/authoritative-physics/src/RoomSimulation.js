import { RoomSimulation as RoomSimulationBase } from './RoomSimulationBase.js'

function tickDelta(left, right)
{
    return ((Number(left) >>> 0) - (Number(right) >>> 0)) | 0
}

export class RoomSimulation extends RoomSimulationBase
{
    inputQueueDiagnostics()
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

        return {
            futureInputCount,
            futureLeadMaxTicks,
            staleInputCount,
            lateInputCount: this.lateInputCount,
        }
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
