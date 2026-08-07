import { performance } from 'node:perf_hooks'
import { cpuUsage, resourceUsage } from 'node:process'

import { encodeStateFrame } from '@ch-folio/authoritative-physics'
import { NodeAuthoritativeRoom } from './NodeAuthoritativeRoom.js'

function cpuMilliseconds(started)
{
    const usage = cpuUsage(started)
    return (usage.user + usage.system) / 1000
}

function contextSwitchDelta(started, completed)
{
    return {
        voluntary: Math.max(
            0,
            completed.voluntaryContextSwitches - started.voluntaryContextSwitches,
        ),
        involuntary: Math.max(
            0,
            completed.involuntaryContextSwitches - started.involuntaryContextSwitches,
        ),
    }
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

    advanceOneTickWithBenchmarkPhases()
    {
        const resourceStarted = resourceUsage()
        const cpuStarted = cpuUsage()
        const rawRecordPhase = this.metrics.recordPhase
        let recordedTickDiagnostics = false

        this.metrics.recordPhase = (name, milliseconds) =>
        {
            if(name === 'totalTick' && !recordedTickDiagnostics)
            {
                recordedTickDiagnostics = true
                const completedResource = resourceUsage()
                const switches = contextSwitchDelta(resourceStarted, completedResource)
                this.metrics.recordDiagnostic('totalTickCpuMs', cpuMilliseconds(cpuStarted))
                this.metrics.recordDiagnostic(
                    'totalTickVoluntaryContextSwitches',
                    switches.voluntary,
                )
                this.metrics.recordDiagnostic(
                    'totalTickInvoluntaryContextSwitches',
                    switches.involuntary,
                )
            }
            return rawRecordPhase.call(this.metrics, name, milliseconds)
        }

        try
        {
            return super.advanceOneTickWithBenchmarkPhases()
        }
        finally
        {
            this.metrics.recordPhase = rawRecordPhase
        }
    }

    broadcastState()
    {
        const broadcastResourceStarted = resourceUsage()
        const broadcastCpuStarted = cpuUsage()
        const broadcastStarted = performance.now()

        let cpuStarted = cpuUsage()
        let started = performance.now()
        const state = this.simulation.readStateFrame(this.eventCursor)
        const stateReadMs = performance.now() - started
        this.metrics.recordPhase('stateRead', stateReadMs)
        this.metrics.recordPhase('stateReadCpu', cpuMilliseconds(cpuStarted))

        const completed = this.completedWorldHashes.shift() ?? null
        state.worldHash = completed

        cpuStarted = cpuUsage()
        started = performance.now()
        const frame = encodeStateFrame(state)
        const stateEncodeMs = performance.now() - started
        this.metrics.recordPhase('stateEncode', stateEncodeMs)
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

        const broadcastCpuMs = cpuMilliseconds(broadcastCpuStarted)
        const completedResource = resourceUsage()
        const switches = contextSwitchDelta(broadcastResourceStarted, completedResource)
        const measuredBroadcastMs = performance.now() - broadcastStarted
        this.metrics.recordPhase(
            'stateBroadcastUnaccounted',
            Math.max(0, measuredBroadcastMs - stateReadMs - stateEncodeMs - stateSocketSendMs),
        )
        this.metrics.recordDiagnostic('stateBroadcastCpuMs', broadcastCpuMs)
        this.metrics.recordDiagnostic(
            'stateBroadcastVoluntaryContextSwitches',
            switches.voluntary,
        )
        this.metrics.recordDiagnostic(
            'stateBroadcastInvoluntaryContextSwitches',
            switches.involuntary,
        )
    }
}
