import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { rewriteSU7FourWheelGlb } from './su7-four-wheel-glb.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputs = process.argv.length > 2
    ? process.argv.slice(2).map((item) => path.resolve(item))
    : [
        path.join(repositoryRoot, 'static', 'vehicle', 'default.glb'),
        path.join(repositoryRoot, 'static', 'vehicle', 'default-compressed.glb'),
    ]

for(const input of inputs)
{
    const source = await readFile(input)
    const result = rewriteSU7FourWheelGlb(source)
    if(result.changed)
        await writeFile(input, result.buffer)

    console.log('[su7-four-wheels]', {
        input: path.relative(repositoryRoot, input),
        changed: result.changed,
        axleAxis: result.axleAxis ?? result.document.asset?.extras?.chFolioSU7FourWheel?.originalAxleAxis,
        center: result.center ?? result.document.asset?.extras?.chFolioSU7FourWheel?.center,
        extents: result.extents ?? result.document.asset?.extras?.chFolioSU7FourWheel?.extents,
    })
}
