import {
    CAMERA_MODES,
    CAMERA_MODE_ORDER,
    nextCameraMode,
} from './cameraModes.js'

export class CameraModeController
{
    constructor(game, { chaseView, cockpitView })
    {
        this.game = game
        this.chaseView = chaseView
        this.cockpitView = cockpitView
        this.mode = CAMERA_MODES.DEFAULT
        this.suspendedByCinematic = false
        this.inputConflictsResolved = this.resolveInputConflicts()

        this.onCameraToggle = (action) =>
        {
            if(action.active)
                this.cycle()
        }

        this.game.inputs.addActions([
            {
                name: 'cameraToggle',
                categories: [ 'wandering', 'racing' ],
                keys: [ 'Keyboard.KeyC', 'Gamepad.r3' ],
            },
        ])
        this.game.inputs.events.on('cameraToggle', this.onCameraToggle)
        this.game.ticker.events.on('tick', () => this.update(), 8)
    }

    resolveInputConflicts()
    {
        const zoomToggleAction = this.game.inputs.actions.get('zoomToggle')
        if(!zoomToggleAction)
            return false

        zoomToggleAction.keys = zoomToggleAction.keys.filter(
            (key) => key !== 'Gamepad.r3',
        )
        zoomToggleAction.activeKeys?.delete('Gamepad.r3')

        if(zoomToggleAction.activeKeys?.size === 0)
        {
            zoomToggleAction.active = false
            zoomToggleAction.value = 0
            zoomToggleAction.trigger = null
        }

        return true
    }

    cycle()
    {
        if(this.game.view?.cinematic?.active)
            return false

        return this.setMode(nextCameraMode(this.mode))
    }

    setMode(mode)
    {
        const nextMode = CAMERA_MODE_ORDER.includes(mode)
            ? mode
            : CAMERA_MODES.DEFAULT

        if(this.game.view?.cinematic?.active)
            return false

        this.exitSpecializedViews()
        this.mode = nextMode
        this.enterSelectedView()

        return true
    }

    exitSpecializedViews()
    {
        this.chaseView.exit()
        this.cockpitView.exit()
    }

    enterSelectedView()
    {
        if(this.mode === CAMERA_MODES.CHASE)
            return this.chaseView.enter()

        if(this.mode === CAMERA_MODES.COCKPIT)
            return this.cockpitView.enter()

        this.restoreDefaultView()
        return true
    }

    restoreDefaultView()
    {
        const view = this.game.view
        if(!view)
            return

        view.setMode?.(view.constructor.MODE_DEFAULT)
        if(view.focusPoint)
            view.focusPoint.isTracking = true

        view.camera.position.copy(view.defaultCamera.position)
        view.camera.quaternion.copy(view.defaultCamera.quaternion)
        view.camera.updateMatrixWorld()
    }

    update()
    {
        if(!this.inputConflictsResolved)
            this.inputConflictsResolved = this.resolveInputConflicts()

        const cinematicActive = this.game.view?.cinematic?.active

        if(cinematicActive)
        {
            if(!this.suspendedByCinematic)
            {
                this.exitSpecializedViews()
                this.suspendedByCinematic = true
            }
            return
        }

        if(this.suspendedByCinematic)
        {
            this.suspendedByCinematic = false
            this.enterSelectedView()
        }
    }
}
