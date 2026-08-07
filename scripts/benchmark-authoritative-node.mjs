import { writeFile } from 'node:fs/promises'

import { runNodeAuthoritativeBenchmark } from '../authoritative-node/src/benchmark.js'
import { AUTHORITATIVE_WARMUP_TICKS } from '../authoritative-node/src/warmup.js'

function parseOptions(argv)
{
    const options = {
        ticks: 36_000,
        warmupTicks: AUTHORITATIVE_WARMUP_TICKS,
        output: null,
        diagnostics: false,
        slowTickThresholdMs: 5,
    }

    for(const argument of argv)
    {
        if(argument.startsWith('--ticks='))
            options.ticks = Number(argument.slice('--ticks='.length))
        else if(argument.startsWith('--warmup-ticks='))
            options.warmupTicks = Number(argument.slice('--warmup-ticks='.length))
        else if(argument.startsWith('--output='))
            options.output = argument.slice('--output='.length)
        else if(argument === '--diagnostics')
            options.diagnostics = true
        else if(argument.startsWith('--slow-tick-threshold-ms='))
            options.slowTickThresholdMs = Number(argument.slice('--slow-tick-threshold-ms='.length))
        else
            throw new Error(`unknown Node benchmark argument ${argument}`)
    }

    return options
}

async function main()
{
    try
    {
        const options = parseOptions(process.argv.slice(2))
        const report = await runNodeAuthoritativeBenchmark(options)
        const json = `${JSON.stringify(report, null, 2)}\n`
        if(options.output)
            await writeFile(options.output, json)
        process.stdout.write(json)
        if(!report.gates.pass)
            process.exitCode = 1
    }
    catch(error)
    {
        process.stderr.write(`${JSON.stringify({
            schemaVersion: 1,
            mode: 'production-warmed-node',
            error: error instanceof Error ? error.message : String(error),
        })}\n`)
        process.exitCode = 1
    }
}

await main()
