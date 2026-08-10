import { NodeAuthoritativeRoom as NodeAuthoritativeRoomBase } from './NodeAuthoritativeRoomBase.js'

export class NodeAuthoritativeRoom extends NodeAuthoritativeRoomBase
{
    readQueueDepth()
    {
        if(this.simulation !== null)
        {
            this.inputQueueDiagnosticsScratch ??= {
                futureInputCount: 0,
                futureLeadMaxTicks: 0,
                staleInputCount: 0,
                lateInputCount: 0,
            }
            this.metrics.recordInputQueueDiagnostics(
                this.simulation.inputQueueDiagnostics(this.inputQueueDiagnosticsScratch),
            )
        }
        return super.readQueueDepth()
    }
}
