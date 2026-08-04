import './localization/zh-CN.js'
import './threejs-override.js'
import { Game } from './Game/Game.js'
import { CockpitView } from './Game/Views/CockpitView.js'
import { SU7FourWheelController } from './Game/World/SU7FourWheelController.js'
import consoleLog from './data/consoleLog.js'

if(import.meta.env.VITE_LOG)
    console.log(
        ...consoleLog
    )

const game = new Game()
const cockpitView = new CockpitView(game)
const su7FourWheelController = new SU7FourWheelController(game)

if(import.meta.env.VITE_GAME_PUBLIC)
{
    window.game = game
    window.cockpitView = cockpitView
    window.su7FourWheelController = su7FourWheelController
}
