import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('application starts multiplayer only with a valid room from the page URL', async () =>
{
    const source = await readSource('../sources/index.js')

    assert.match(source, /roomFromUrl\.js/)
    assert.match(source, /resolveRoomFromSearch\(window\.location\.search\)/)
    assert.match(source, /multiplayerEnabled\s*&&\s*import\.meta\.env\.VITE_SERVER_URL\s*&&\s*multiplayerRoom/)
    assert.match(source, /multiplayer\.start\(\{\s*room:\s*multiplayerRoom\s*\}\)/)
    assert.doesNotMatch(source, /\nif\(multiplayerEnabled\s*&&\s*import\.meta\.env\.VITE_SERVER_URL\)\s*\n\s*multiplayer\.start\(\)/)
})

test('multiplayer requires an explicit room and has no environment default room', async () =>
{
    const source = await readSource('../sources/Game/Multiplayer/Multiplayer.js')

    assert.match(source, /start\(\{\s*room\s*\}\s*=\s*\{\}\)/)
    assert.match(source, /if\(this\.started\s*\|\|\s*!room\)/)
    assert.match(source, /this\.server\.start\(\{[\s\S]*room,[\s\S]*\}\)/)
    assert.doesNotMatch(source, /VITE_MULTIPLAYER_ROOM/)
})
