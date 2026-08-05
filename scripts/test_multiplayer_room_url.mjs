import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveRoomFromSearch } from '../sources/Game/Multiplayer/roomFromUrl.js'

test('missing or empty room query keeps the page in single-player mode', () =>
{
    assert.equal(resolveRoomFromSearch(''), null)
    assert.equal(resolveRoomFromSearch('?foo=1'), null)
    assert.equal(resolveRoomFromSearch('?room='), null)
    assert.equal(resolveRoomFromSearch('?room=%20%20%20'), null)
})

test('valid room query is trimmed and normalized to lowercase', () =>
{
    assert.equal(resolveRoomFromSearch('?room=%20ABC_12-%20'), 'abc_12-')
    assert.equal(resolveRoomFromSearch('?room=team-one&foo=1'), 'team-one')
})

test('invalid or oversized room query keeps the page in single-player mode', () =>
{
    assert.equal(resolveRoomFromSearch('?room=hello/world'), null)
    assert.equal(resolveRoomFromSearch('?room=hello%20world'), null)
    assert.equal(resolveRoomFromSearch('?room=%E6%88%BF%E9%97%B4'), null)
    assert.equal(resolveRoomFromSearch(`?room=${'a'.repeat(65)}`), null)
})
