import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    CAMERA_TOGGLE_CONTROL,
    addCameraToggleControlHelp,
    cameraToggleControlRowMarkup,
    installCameraToggleControlHelp,
} from '../sources/Game/Views/cameraControlsHelp.js'

function createFakeDocument(readyState = 'complete')
{
    let html = ''
    const listeners = new Map()
    const tbody = {
        querySelector(selector)
        {
            assert.equal(selector, '[data-control="camera-toggle"]')
            return html.includes('data-control="camera-toggle"') ? {} : null
        },
        insertAdjacentHTML(position, value)
        {
            assert.equal(position, 'beforeend')
            html += value
        },
        get html()
        {
            return html
        },
    }

    return {
        readyState,
        tbody,
        querySelector(selector)
        {
            assert.equal(selector, '.controls-content .mouse-keyboard tbody')
            return tbody
        },
        addEventListener(type, listener, options)
        {
            assert.equal(type, 'DOMContentLoaded')
            assert.deepEqual(options, { once: true })
            listeners.set(type, listener)
        },
        dispatch(type)
        {
            listeners.get(type)?.()
        },
    }
}

test('camera toggle help uses C and the Chinese settings label', () =>
{
    assert.deepEqual(CAMERA_TOGGLE_CONTROL, {
        key: 'C',
        label: '切换视角',
    })
    assert.match(cameraToggleControlRowMarkup(), /<span class="key">C<\/span>/)
    assert.match(cameraToggleControlRowMarkup(), /<td>切换视角<\/td>/)
})

test('camera toggle help is appended to keyboard and mouse controls once', () =>
{
    const documentRef = createFakeDocument()

    assert.equal(addCameraToggleControlHelp(documentRef), true)
    assert.equal(addCameraToggleControlHelp(documentRef), false)
    assert.equal(
        documentRef.tbody.html.match(/data-control="camera-toggle"/g)?.length,
        1,
    )
})

test('camera toggle help waits for DOMContentLoaded when needed', () =>
{
    const documentRef = createFakeDocument('loading')

    assert.equal(installCameraToggleControlHelp(documentRef), false)
    assert.equal(documentRef.tbody.html, '')

    documentRef.dispatch('DOMContentLoaded')

    assert.match(documentRef.tbody.html, /data-control="camera-toggle"/)
})

test('application entry installs the camera toggle controls help', async () =>
{
    const source = await readFile(
        new URL('../sources/index.js', import.meta.url),
        'utf8',
    )

    assert.match(source, /cameraControlsHelp\.js/)
    assert.match(source, /installCameraToggleControlHelp\(\)/)
})
