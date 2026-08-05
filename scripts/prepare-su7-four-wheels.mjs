import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { rewriteSU7FourWheelGlb } from './su7-four-wheel-glb.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requestedPaths = process.argv.slice(2)
const targets = requestedPaths.length > 0
    ? requestedPaths.map((item) => path.resolve(repositoryRoot, item))
    : [
        path.join(repositoryRoot, 'static', 'vehicle', 'default.glb'),
        path.join(repositoryRoot, 'static', 'vehicle', 'default-compressed.glb'),
    ]

for(const target of targets)
{
    const input = await readFile(target)
    const result = rewriteSU7FourWheelGlb(input)
    if(result.changed)
        await writeFile(target, result.buffer)

    console.info('[su7-four-wheels]', {
        target: path.relative(repositoryRoot, target),
        changed: result.changed,
        bodyScale: result.bodyScale,
        bodyTranslation: result.bodyTranslation,
    })
}
