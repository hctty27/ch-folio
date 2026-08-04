import './localization/zh-CN.js'
import './threejs-override.js'
import { Game } from './Game/Game.js'
import { CockpitView } from './Game/Views/CockpitView.js'
import consoleLog from './data/consoleLog.js'

if(import.meta.env.VITE_LOG)
    console.log(
        ...consoleLog
    )

const game = new Game()
const cockpitView = new CockpitView(game)

if(import.meta.env.VITE_GAME_PUBLIC)
{
    window.game = game
    window.cockpitView = cockpitView
}
