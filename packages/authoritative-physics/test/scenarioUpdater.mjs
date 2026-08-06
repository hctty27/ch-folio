import { writeFile } from 'node:fs/promises'

import { runAuthoritativeScenario } from './scenarioHarness.mjs'

export function assertExpectedUpdateAllowed(environment = process.env)
{
    if(environment.CI || environment.GITHUB_ACTIONS)
        throw new Error('scenario updater refuses to update expected values in CI')
    if(environment.UPDATE_EXPECTED !== '1')
        throw new Error('set UPDATE_EXPECTED=1 to update deterministic scenario expectations')
}

export async function updateScenarioExpectations({ RAPIER, fixtures })
{
    assertExpectedUpdateAllowed(process.env)

    for(const { fileName, fixture } of fixtures)
    {
        const expected = await runAuthoritativeScenario({ RAPIER, fixture })
        const updated = {
            ...fixture,
            expected,
        }
        await writeFile(
            new URL(`./fixtures/${fileName}`, import.meta.url),
            `${JSON.stringify(updated, null, 2)}\n`,
            'utf8',
        )
    }
}
