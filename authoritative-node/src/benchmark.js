import { runLocalBenchmark } from '../../scripts/benchmark-authoritative-room.mjs'
import {
    AUTHORITATIVE_WARMUP_TICKS,
    RAPIER,
    runAuthoritativeWarmup,
} from './warmup.js'

export async function runNodeAuthoritativeBenchmark({
    ticks = 36_000,
    warmupTicks = AUTHORITATIVE_WARMUP_TICKS,
    diagnostics = false,
    slowTickThresholdMs = 5,
} = {})
{
    const warmup = runAuthoritativeWarmup({ ticks: warmupTicks })
    const report = await runLocalBenchmark({
        ticks,
        diagnostics,
        slowTickThresholdMs,
        rapier: RAPIER,
    })

    report.metadata.productionWarmupTicks = warmup.ticks
    report.metadata.productionWarmupVehicles = warmup.vehicles
    return report
}
