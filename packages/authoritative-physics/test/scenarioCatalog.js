import lowHeadOn from './fixtures/low-head-on.json' with { type: 'json' }
import highHeadOn from './fixtures/high-head-on.json' with { type: 'json' }
import rearEnd from './fixtures/rear-end.json' with { type: 'json' }
import sideImpact from './fixtures/side-impact.json' with { type: 'json' }
import angledSqueeze from './fixtures/angled-squeeze.json' with { type: 'json' }
import barrierImpact from './fixtures/barrier-impact.json' with { type: 'json' }
import rampLanding from './fixtures/ramp-landing.json' with { type: 'json' }
import roofContact from './fixtures/roof-contact.json' with { type: 'json' }
import ccdTunneling from './fixtures/ccd-tunneling.json' with { type: 'json' }
import occupiedSpawn from './fixtures/occupied-spawn.json' with { type: 'json' }
import eightCarPileup from './fixtures/eight-car-pileup.json' with { type: 'json' }

export const REQUIRED_SCENARIO_IDS = Object.freeze([
    'low-head-on',
    'high-head-on',
    'rear-end',
    'side-impact',
    'angled-squeeze',
    'barrier-impact',
    'ramp-landing',
    'roof-contact',
    'ccd-tunneling',
    'occupied-spawn',
    'eight-car-pileup',
])

const entries = [
    [ 'low-head-on.json', lowHeadOn ],
    [ 'high-head-on.json', highHeadOn ],
    [ 'rear-end.json', rearEnd ],
    [ 'side-impact.json', sideImpact ],
    [ 'angled-squeeze.json', angledSqueeze ],
    [ 'barrier-impact.json', barrierImpact ],
    [ 'ramp-landing.json', rampLanding ],
    [ 'roof-contact.json', roofContact ],
    [ 'ccd-tunneling.json', ccdTunneling ],
    [ 'occupied-spawn.json', occupiedSpawn ],
    [ 'eight-car-pileup.json', eightCarPileup ],
]

export const scenarioFixtures = Object.freeze(entries.map(([ fileName, fixture ]) =>
    Object.freeze({ fileName, fixture: Object.freeze(fixture) })))
