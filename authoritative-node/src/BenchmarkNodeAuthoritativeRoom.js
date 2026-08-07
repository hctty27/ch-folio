import { performance } from 'node:perf_hooks'
import { cpuUsage } from 'node:process'

import { encodeStateFrame } from '@ch-folio/authoritative-physics'
import { NodeAuthoritativeRoom } from './NodeAuthoritativeRoom.js'

function cpuMilliseconds(started)
{
    const usage = cpuUsage(started)
    return (usage.user + usage.system) / 1000
}

export class BenchmarkNodeAuthoritativeRoom extends NodeAuthoritativeRoom
{
    ensureRuntime()
    {
        const alreadyLoaded = this.simulation !== null
        super.ensureRuntime()
        if(alreadyLoaded || this.simulation === null)
            return

        let rapierStepMs = 0
        let rapierStepCpuMs = 0
        let authoritativeWorldMs = 0
        let authoritativeWorldCpuMs = 0

        const rapierWorld = this.authoritativeWorld.world
        const rawRapierStep = rapierWorld.step.bind(rapierWorld)
        rapierWorld.step = (...args) =>
        {
            const cpuStarted = cpuUsage()
            const started = performance.now()
            const result = rawRapierStep(...args)
            rapierStepMs += performance.now() - started
            rapierStepCpuMs += cpuMilliseconds(cpuStarted)
            return result
        }

        const rawAuthoritativeWorldStep = this.authoritativeWorld.step.bind(this.authoritativeWorld)
        this.authoritativeWorld.step = (...args) =>
        {
            const cpuStarted = cpuUsage()
            const started = performance.now()
            const result = rawAuthoritativeWorldStep(...args)
            authoritativeWorldMs += performance.now() - started
            authoritativeWorldCpuMs += cpuMilliseconds(cpuStarted)
            return result
        }

        const rawSimulationAdvance = this.simulation.advanceOneTick.bind(this.simulation)
        this.simulation.advanceOneTick = (...args) =>
        {
            rapierStepMs = 0
            rapierStepCpuMs = 0
            authoritativeWorldMs = 0
            authoritativeWorldCpuMs = 0

            const cpuStarted = cpuUsage()
            const started = performance.now()
            const result = rawSimulationAdvance(...args)
            const simulationAdvanceMs = performance.now() - started
            const simulationAdvanceCpuMs = cpuMilliseconds(cpuStarted)

            this.metrics.recordPhase('rapierStep', rapierStepMs)
            this.metrics.recordPhase('rapierStepCpu', rapierStepCpuMs)
            this.metrics.recordPhase(
                'authoritativeControllerUpdate',
                Math.max(0, authoritativeWorldMs - rapierStepMs),
            )
            this.metrics.recordPhase(
                'authoritativeControllerUpdateCpu',
                Math.max(0, authoritativeWorldCpuMs - rapierStepCpuMs),
            )
            this.metrics.recordPhase(
                'simulationBookkeeping',
                Math.max(0, simulationAdvanceMs - authoritativeWorldMs),
            )
            this.metrics.recordPhase(
                'simulationBookkeepingCpu',
                Math.max(0, simulationAdvanceCpuMs - authoritativeWorldCpuMs),
            )
            this.metrics.recordPhase(
                'simulationNonRapier',
                Math.max(0, simulationAdvanceMs - rapierStepMs),
            )
            this.metrics.recordPhase(
                'simulationNonRapierCpu',
                Math.max(0, simulationAdvanceCpuMs - rapierStepCpuMs),
            )
            return result
        }
    }

    broadcastState()
    {
        let cpuStarted = cpuUsage()
        let started = performance.now()
        const state = this.simulation.readStateFrame(this.eventCursor)
        this.metrics.recordPhase('stateRead', performance.now() - started)
        this.metrics.recordPhase('stateReadCpu', cpuMilliseconds(cpuStarted))

        const completed = this.completedWorldHashes.shift() ?? null
        state.worldHash = completed

        cpuStarted = cpuUsage()
        started = performance.now()
        const frame = encodeStateFrame(state)
        this.metrics.recordPhase('stateEncode', performance.now() - started)
        this.metrics.recordPhase('stateEncodeCpu', cpuMilliseconds(cpuStarted))
        this.eventCursor = state.eventCursor

        let sendCallTotalMs = 0
        let sendCallMaxMs = 0
        cpuStarted = cpuUsage()
        started = performance.now()
        for(const socket of this.sockets)
        {
            const attachment = this.attachments.get(socket)
            if(
                attachment?.handshake !== 'session_active'
                || attachment.playerId === null
                || attachment.generation === null
                || !this.sessions.isCurrentController(attachment.playerId, attachment.generation)
            )
                continue

            const sendStarted = performance.now()
            this.safeSend(socket, frame)
            const sendMs = performance.now() - sendStarted
            sendCallTotalMs += sendMs
            sendCallMaxMs = Math.max(sendCallMaxMs, sendMs)
        }
        const stateSocketSendMs = performance.now() - started
        this.metrics.recordPhase('stateSocketSend', stateSocketSendMs)
        this.metrics.recordPhase('stateSocketSendCpu', cpuMilliseconds(cpuStarted))
        this.metrics.recordPhase('stateSocketSendCallTotal', sendCallTotalMs)
        this.metrics.recordPhase('stateSocketSendCallMax', sendCallMaxMs)
        this.metrics.recordPhase(
            'stateSocketSendLoopOverhead',
            Math.max(0, stateSocketSendMs - sendCallTotalMs),
        )
    }
}
