export const CAMERA_TOGGLE_CONTROL = Object.freeze({
    key: 'C',
    label: '切换视角',
})

export function createCameraToggleControlRow(documentRef)
{
    const row = documentRef.createElement('tr')
    row.dataset.control = 'camera-toggle'

    const keyCell = documentRef.createElement('td')
    const key = documentRef.createElement('span')
    key.className = 'key'
    key.textContent = CAMERA_TOGGLE_CONTROL.key
    keyCell.append(key)

    const labelCell = documentRef.createElement('td')
    labelCell.textContent = CAMERA_TOGGLE_CONTROL.label

    row.append(keyCell, labelCell)
    return row
}

export function addCameraToggleControlHelp(documentRef = globalThis.document)
{
    if(!documentRef?.querySelector || !documentRef?.createElement)
        return false

    const tableBody = documentRef.querySelector(
        '.controls-content .mouse-keyboard tbody',
    )

    if(!tableBody || tableBody.querySelector('[data-control="camera-toggle"]'))
        return false

    tableBody.append(createCameraToggleControlRow(documentRef))
    return true
}

export function installCameraToggleControlHelp(documentRef = globalThis.document)
{
    if(!documentRef)
        return false

    if(documentRef.readyState === 'loading')
    {
        documentRef.addEventListener(
            'DOMContentLoaded',
            () => addCameraToggleControlHelp(documentRef),
            { once: true },
        )
        return false
    }

    return addCameraToggleControlHelp(documentRef)
}
