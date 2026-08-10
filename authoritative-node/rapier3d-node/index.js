import { createRequire } from 'node:module'
import { cp, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

async function pathExists(path)
{
    try
    {
        await stat(path)
        return true
    }
    catch(error)
    {
        if(error?.code === 'ENOENT')
            return false
        throw error
    }
}

async function resolveRelativeSpecifier(filePath, specifier)
{
    if(extname(specifier) !== '')
        return specifier

    const basePath = resolve(dirname(filePath), specifier)
    if(await pathExists(`${basePath}.js`))
        return `${specifier}.js`
    if(await pathExists(join(basePath, 'index.js')))
        return `${specifier}/index.js`

    return specifier
}

async function patchModuleSpecifiers(filePath)
{
    const source = await readFile(filePath, 'utf8')
    const replacements = []
    const pattern = /(?:from\s*|import\s*\(|import\s+)(['"])(\.\.?\/[^'"]+)\1/g

    for(const match of source.matchAll(pattern))
    {
        const specifier = match[2]
        const replacement = await resolveRelativeSpecifier(filePath, specifier)
        if(replacement === specifier)
            continue

        const relativeIndex = match[0].lastIndexOf(specifier)
        replacements.push({
            start: match.index + relativeIndex,
            end: match.index + relativeIndex + specifier.length,
            replacement,
        })
    }

    if(replacements.length === 0)
        return

    let patched = source
    for(const replacement of replacements.reverse())
    {
        patched = patched.slice(0, replacement.start)
            + replacement.replacement
            + patched.slice(replacement.end)
    }

    await writeFile(filePath, patched)
}

async function patchJavaScriptTree(directory)
{
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for(const entry of entries)
    {
        const path = join(directory, entry.name)
        if(entry.isDirectory())
            await patchJavaScriptTree(path)
        else if(entry.isFile() && entry.name.endsWith('.js'))
            await patchModuleSpecifiers(path)
    }
}

async function loadRapierForNode()
{
    const rapierEntry = require.resolve('@dimforge/rapier3d-deterministic/rapier.js')
    const sourceRoot = dirname(rapierEntry)
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'ch-folio-rapier-node-'))

    await cp(sourceRoot, temporaryRoot, { recursive: true })
    await writeFile(join(temporaryRoot, 'package.json'), '{"type":"module"}\n')
    await patchJavaScriptTree(temporaryRoot)

    const wasmLoader = `import { readFileSync } from 'node:fs'
import * as imports from './rapier_wasm3d_bg.js'

const bytes = readFileSync(new URL('./rapier_wasm3d_bg.wasm', import.meta.url))
const module = new WebAssembly.Module(bytes)
const instance = new WebAssembly.Instance(module, {
    './rapier_wasm3d_bg.js': imports,
})
imports.__wbg_set_wasm(instance.exports)

export * from './rapier_wasm3d_bg.js'
`
    await writeFile(join(temporaryRoot, 'rapier_wasm3d.js'), wasmLoader)

    const module = await import(pathToFileURL(join(temporaryRoot, 'rapier.js')).href)
    return module.default
}

const RAPIER = await loadRapierForNode()

export default RAPIER
