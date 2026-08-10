import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    buildNodeBenchmarkWebSocketUrl,
    parseNodeLoadTestOptions,
    runNodeLoadTest as runBaseNodeLoadTest,
} from './loadtest-authoritative-node-base.mjs'

export {
    FrameRouter,
    buildNodeBenchmarkWebSocketUrl,
    parseNodeLoadTestOptions,
} from './loadtest-authoritative-node-base.mjs'

function failure(failures, gate, actual, limit, comparison = '<=')
{
    failures.push({ gate, actual, limit, comparison })
}

function finiteOrInfinity(value)
{
    return Number.isFinite(value) ? Number(value) : Number.POSITIVE_INFINITY
}

export function evaluateNodeLoadTestGates(report)
{
    const failures = []
    const totalTick = report?.server?.phases?.totalTick ?? {}
    const p95 = finiteOrInfinity(totalTick.p95Ms)
    const p99 = finiteOrInfinity(totalTick.p99Ms)
    const max = finiteOrInfinity(totalTick.maxMs)
    const futureLead = finiteOrInfinity(report?.server?.gauges?.futureLeadMaxTicks)
    const stale = finiteOrInfinity(report?.server?.gauges?.staleInputMax)
    const persistentGrowth = report?.server?.gauges?.persistentFutureQueueGrowth === true
    const overload = finiteOrInfinity(report?.server?.scheduler?.overloadCallbacks)
    const disconnects = finiteOrInfinity(report?.disconnects)
    const backlog = finiteOrInfinity(report?.backlog?.persistent)
    const divergence = finiteOrInfinity(report?.divergence?.persistent)
    const roomRestarts = finiteOrInfinity(report?.roomRestarts)

    if(p95 > 8) failure(failures, 'server.totalTick.p95Ms', p95, 8)
    if(p99 > 12) failure(failures, 'server.totalTick.p99Ms', p99, 12)
    if(max > 16.67) failure(failures, 'server.totalTick.maxMs', max, 16.67)
    if(stale > 0) failure(failures, 'server.gauges.staleInputMax', stale, 0)
    if(futureLead > 18) failure(failures, 'server.gauges.futureLeadMaxTicks', futureLead, 18)
    if(persistentGrowth)
    {
        failure(
            failures,
            'server.gauges.persistentFutureQueueGrowth',
            persistentGrowth,
            false,
            '===',
        )
    }
    if(overload > 0) failure(failures, 'server.scheduler.overloadCallbacks', overload, 0)
    if(disconnects > 0) failure(failures, 'disconnects', disconnects, 0)
    if(backlog > 0) failure(failures, 'backlog.persistent', backlog, 0)
    if(divergence > 0) failure(failures, 'divergence.persistent', divergence, 0)
    if(roomRestarts > 0) failure(failures, 'roomRestarts', roomRestarts, 0)

    return { pass: failures.length === 0, failures }
}

export async function runNodeLoadTest(options)
{
    const report = await runBaseNodeLoadTest(options)
    report.gates = evaluateNodeLoadTestGates(report)
    return report
}

async function main()
{
    try
    {
        const options = parseNodeLoadTestOptions()
        const report = await runNodeLoadTest(options)
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        if(!report.gates.pass)
            process.exitCode = 1
    }
    catch(error)
    {
        process.stderr.write(`${JSON.stringify({
            schemaVersion: 1,
            mode: 'deployed-node',
            error: error instanceof Error ? error.message : String(error),
        })}\n`)
        process.exitCode = 1
    }
}

const isMain = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if(isMain)
    await main()