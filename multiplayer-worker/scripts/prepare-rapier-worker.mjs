import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const expectedPackage = '@dimforge/rapier3d-deterministic'
const expectedVersion = '0.17.3'
const packageRoot = fileURLToPath(new URL('../node_modules/@dimforge/rapier3d/', import.meta.url))
const packageJsonPath = `${packageRoot}/package.json`
const loaderPath = `${packageRoot}/rapier_wasm3d.js`
const bindingsPath = `${packageRoot}/rapier_wasm3d_bg.js`
const wasmPath = `${packageRoot}/rapier_wasm3d_bg.wasm`

for(const path of [ packageJsonPath, loaderPath, bindingsPath, wasmPath ])
{
    if(!existsSync(path))
        throw new Error(`Rapier Worker preparation requires ${path}`)
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

if(packageJson.name !== expectedPackage || packageJson.version !== expectedVersion)
{
    throw new Error(
        `Expected ${expectedPackage}@${expectedVersion}, received ${packageJson.name}@${packageJson.version}`,
    )
}

const workerLoader = `import * as imports from './rapier_wasm3d_bg.js'
import wkmod from './rapier_wasm3d_bg.wasm'
import * as nodemod from './rapier_wasm3d_bg.wasm'

if(typeof process !== 'undefined' && process.release?.name === 'node')
{
    imports.__wbg_set_wasm(nodemod)
}
else
{
    const instance = new WebAssembly.Instance(wkmod, {
        './rapier_wasm3d_bg.js': imports,
    })
    imports.__wbg_set_wasm(instance.exports)
}

export * from './rapier_wasm3d_bg.js'
`

if(readFileSync(loaderPath, 'utf8') !== workerLoader)
    writeFileSync(loaderPath, workerLoader)

console.log(`[rapier-worker] prepared ${expectedPackage}@${expectedVersion}`)
