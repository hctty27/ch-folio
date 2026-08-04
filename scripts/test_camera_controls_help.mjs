import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
    CAMERA_TOGGLE_CONTROL,
    addCameraToggleControlHelp,
    createCameraToggleControlRow,
    installCameraToggleControlHelp,
} from '../sources/Game/Views/cameraControlsHelp.js'

class FakeElement
{
    constructor(tagName)
    {
        this.tagName = tagName
        this.dataset = {}
        this.className = ''
        this.textContent = ''
        this.children = []
    }

    append(...children)
    {
        this.children.push(...children)
    }

    querySelector(selector)
    {
        assert.equal(selector, '[data-control="camera-toggle"]')
        return this.children.find(
            (child) => child.dataset.control === 'camera-toggle',
        ) ?? null
    }
}

function createFakeDocument(readyState = 'complete')
{
    const listeners = new Map()
    const tbody = new FakeElement('tbody')

    return {
        readyState,
        tbody,
        createElement(tagName)
        {
            return new FakeElement(tagName)
        },
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

    const documentRef = createFakeDocument()
    const row = createCameraToggleControlRow(documentRef)
    const [keyCell, labelCell] = row.children
    const key = keyCell.children[0]

    assert.equal(row.dataset.control, 'camera-toggle')
    assert.equal(key.className, 'key')
    assert.equal(key.textContent, 'C')
    assert.equal(labelCell.textContent, '切换视角')
})

test('camera toggle help is appended to keyboard and mouse controls once', () =>
{
    const documentRef = createFakeDocument()

    assert.equal(addCameraToggleControlHelp(documentRef), true)
    assert.equal(addCameraToggleControlHelp(documentRef), false)
    assert.equal(documentRef.tbody.children.length, 1)
})

test('camera toggle help waits for DOMContentLoaded when needed', () =>
{
    const documentRef = createFakeDocument('loading')

    assert.equal(installCameraToggleControlHelp(documentRef), false)
    assert.equal(documentRef.tbody.children.length, 0)

    documentRef.dispatch('DOMContentLoaded')

    assert.equal(documentRef.tbody.children.length, 1)
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
