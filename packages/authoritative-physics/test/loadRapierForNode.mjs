import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
    const matches = []
    const pattern = /(?:from\s*|import\s*\(|import\s+)(['"])(\.\.?\/[^'"]+)\1/g

    for(const match of source.matchAll(pattern))
    {
        const specifier = match[2]
        const replacement = await resolveRelativeSpecifier(filePath, specifier)
        if(replacement !== specifier)
        {
            const relativeIndex = match[0].lastIndexOf(specifier)
            matches.push({
                start: match.index + relativeIndex,
                end: match.index + relativeIndex + specifier.length,
                replacement,
            })
        }
    }

    if(matches.length === 0)
        return

    let patched = source
    for(const match of matches.reverse())
        patched = patched.slice(0, match.start) + match.replacement + patched.slice(match.end)

    await writeFile(filePath, patched)
}

async function patchJavaScriptTree(directory)
{
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

    for(const entry of entries)
    {
        const path = join(directory, entry.name)
        if(entry.isDirectory())
            await patchJavaScriptTree(path)
        else if(entry.isFile() && entry.name.endsWith('.js'))
            await patchModuleSpecifiers(path)
    }
}

export async function loadRapierForNode({
    temporaryParent = tmpdir(),
    onTemporaryRoot = null,
} = {})
{
    if(typeof temporaryParent !== 'string' || temporaryParent.length === 0)
        throw new TypeError('temporaryParent must be a non-empty path')
    if(onTemporaryRoot !== null && typeof onTemporaryRoot !== 'function')
        throw new TypeError('onTemporaryRoot must be a function when provided')

    const sourceRoot = fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d/', import.meta.url))
    const temporaryRoot = await mkdtemp(join(temporaryParent, 'ch-folio-rapier-'))
    onTemporaryRoot?.(temporaryRoot)

    try
    {
        await cp(sourceRoot, temporaryRoot, { recursive: true })
        await writeFile(join(temporaryRoot, 'package.json'), '{"type":"module"}\n')
        await patchJavaScriptTree(temporaryRoot)

        const loader = `import { readFileSync } from 'node:fs'
import * as imports from './rapier_wasm3d_bg.js'

const bytes = readFileSync(new URL('./rapier_wasm3d_bg.wasm', import.meta.url))
const module = new WebAssembly.Module(bytes)
const instance = new WebAssembly.Instance(module, {
    './rapier_wasm3d_bg.js': imports,
})
imports.__wbg_set_wasm(instance.exports)

export * from './rapier_wasm3d_bg.js'
`
        await writeFile(join(temporaryRoot, 'rapier_wasm3d.js'), loader)

        const module = await import(pathToFileURL(join(temporaryRoot, 'rapier.js')).href)
        return module.default
    }
    finally
    {
        await rm(temporaryRoot, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
        })
    }
}
