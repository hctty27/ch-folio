import { NodeAuthoritativeRoom as NodeAuthoritativeRoomBase } from './NodeAuthoritativeRoomBase.js'

export class NodeAuthoritativeRoom extends NodeAuthoritativeRoomBase
{
    readQueueDepth()
    {
        if(this.simulation !== null)
        {
            this.metrics.recordInputQueueDiagnostics(
                this.simulation.inputQueueDiagnostics(),
            )
        }
        return super.readQueueDepth()
    }
}
