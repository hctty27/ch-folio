import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('single-player vehicle uses the shared deterministic configuration and controller helper', async () =>
{
    const source = await readSource('../sources/Game/Physics/PhysicsVehicle.js')

    assert.match(source, /from '@ch-folio\/authoritative-physics'/)
    assert.match(source, /VEHICLE_CONFIG/)
    assert.match(source, /createQuantizedInputFromPlayer/)
    assert.match(source, /applyVehicleInput/)
    assert.match(source, /VEHICLE_CONFIG\.chassis\.colliders\.map/)
    assert.match(source, /VEHICLE_CONFIG\.wheels\.positions/)
    assert.match(source, /enableCcd\(VEHICLE_CONFIG\.ccdEnabled\)/)
    assert.match(source, /setAdditionalSolverIterations\(VEHICLE_CONFIG\.additionalSolverIterations\)/)
    assert.match(source, /integrationParameters\.maxCcdSubsteps\s*=\s*VEHICLE_CONFIG\.maxCcdSubsteps/)
    assert.match(source, /createQuantizedInputFromPlayer\(\s*this\.game\.player,\s*this\.controlTick,\s*this\.controlSequence/)
    assert.match(source, /applyVehicleInput\(\s*this\.controller,\s*this\.chassis\.physical\.body,/)
    assert.doesNotMatch(source, /const topSpeed = lerp\(this\.topSpeed/)
    assert.doesNotMatch(source, /this\.controller\.updateVehicle\(delta\)/)

    assert.match(source, /updatePrePhysics\(\)\s*\n\s*\{[\s\S]*this\.controlTick = \(this\.controlTick \+ 1\) >>> 0/)
    assert.match(source, /this\.game\.ticker\.events\.on\('tick',[\s\S]*this\.updatePrePhysics\(\)[\s\S]*\}, 2\)/)
    assert.match(source, /this\.game\.ticker\.events\.on\('tick',[\s\S]*this\.updatePostPhysics\(\)[\s\S]*\}, 5\)/)
})

test('player exposes every raw field consumed by shared quantization without changing ticker priority', async () =>
{
    const source = await readSource('../sources/Game/Player.js')

    assert.match(source, /this\.accelerating = 0/)
    assert.match(source, /this\.steering = 0/)
    assert.match(source, /this\.boosting = 0/)
    assert.match(source, /this\.braking = 0/)
    assert.match(source, /this\.honking = 0/)
    assert.match(source, /this\.suspensions = \['low', 'low', 'low', 'low'\]/)
    assert.match(source, /this\.honking = this\.game\.inputs\.actions\.get\('honk'\)\.active \? 1 : 0/)
    assert.match(source, /this\.game\.ticker\.events\.on\('tick',[\s\S]*this\.updatePrePhysics\(\)[\s\S]*\}, 1\)/)
    assert.match(source, /this\.game\.ticker\.events\.on\('tick',[\s\S]*this\.updatePostPhysics\(\)[\s\S]*\}, 6\)/)
})

test('root test command includes the authoritative vehicle bridge regression', async () =>
{
    const packageJson = JSON.parse(await readSource('../package.json'))

    assert.match(packageJson.scripts['test:js'], /test_authoritative_vehicle_bridge\.mjs/)
    assert.equal(
        packageJson.scripts['test:authoritative-vehicle'],
        'node --test packages/authoritative-physics/test/vehicleConfig.test.mjs scripts/test_authoritative_vehicle_bridge.mjs',
    )
})
