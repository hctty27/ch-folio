import { performance } from 'node:perf_hooks'

import { NodeAuthoritativeRoom } from './NodeAuthoritativeRoom.js'

export class BenchmarkNodeAuthoritativeRoom extends NodeAuthoritativeRoom
{
    ensureRuntime()
    {
        const alreadyLoaded = this.simulation !== null
        super.ensureRuntime()
        if(alreadyLoaded || this.simulation === null)
            return

        let rapierStepMs = 0
        const rapierWorld = this.authoritativeWorld.world
        const rawRapierStep = rapierWorld.step.bind(rapierWorld)
        rapierWorld.step = (...args) =>
        {
            const started = performance.now()
            const result = rawRapierStep(...args)
            rapierStepMs += performance.now() - started
            return result
        }

        const rawSimulationAdvance = this.simulation.advanceOneTick.bind(this.simulation)
        this.simulation.advanceOneTick = (...args) =>
        {
            rapierStepMs = 0
            const started = performance.now()
            const result = rawSimulationAdvance(...args)
            const simulationAdvanceMs = performance.now() - started
            this.metrics.recordPhase('rapierStep', rapierStepMs)
            this.metrics.recordPhase(
                'simulationNonRapier',
                Math.max(0, simulationAdvanceMs - rapierStepMs),
            )
            return result
        }
    }
}
