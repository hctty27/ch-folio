import './localization/zh-CN.js'
import './threejs-override.js'
import { Game } from './Game/Game.js'
import { CameraModeController } from './Game/Views/CameraModeController.js'
import { ChaseView } from './Game/Views/ChaseView.js'
import { CockpitView } from './Game/Views/CockpitView.js'
import { installCameraToggleControlHelp } from './Game/Views/cameraControlsHelp.js'
import { SU7FourWheelController } from './Game/World/SU7FourWheelController.js'
import consoleLog from './data/consoleLog.js'

if(import.meta.env.VITE_LOG)
    console.log(
        ...consoleLog
    )

installCameraToggleControlHelp()

const game = new Game()
const cockpitView = new CockpitView(game)
const chaseView = new ChaseView(game)
const cameraModeController = new CameraModeController(game, {
    chaseView,
    cockpitView,
})
const su7FourWheelController = new SU7FourWheelController(game)

if(import.meta.env.VITE_GAME_PUBLIC)
{
    window.game = game
    window.cockpitView = cockpitView
    window.chaseView = chaseView
    window.cameraModeController = cameraModeController
    window.su7FourWheelController = su7FourWheelController
}
