import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('multiplayer owns a transport separate from the legacy game server', async () =>
{
    const multiplayerSource = await readSource('../sources/Game/Multiplayer/Multiplayer.js')
    const transportSource = await readSource('../sources/Game/Multiplayer/Server.js')
    const legacyServerSource = await readSource('../sources/Game/Server.js')

    assert.match(multiplayerSource, /import\s+\{\s*MultiplayerServer\s*\}\s+from\s+['"]\.\/Server\.js['"]/)
    assert.match(multiplayerSource, /this\.server\s*=\s*new MultiplayerServer\(game\)/)
    assert.doesNotMatch(multiplayerSource, /this\.game\.server/)

    assert.match(transportSource, /export class MultiplayerServer/)
    assert.match(transportSource, /searchParams\.set\(['"]room['"],\s*this\.room\)/)
    assert.match(transportSource, /is-multiplayer-online/)
    assert.doesNotMatch(transportSource, /is-server-online/)

    assert.match(legacyServerSource, /export class Server/)
    assert.doesNotMatch(legacyServerSource, /normalizeRoom|searchParams\.set\(['"]room['"]/)
})
