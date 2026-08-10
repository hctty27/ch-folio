import './localization/zh-CN.js'
import './threejs-override.js'
import { Game } from './Game/Game.js'
import { Multiplayer } from './Game/Multiplayer/Multiplayer.js'
import { resolveRoomFromSearch } from './Game/Multiplayer/roomFromUrl.js'
import { AuthoritativeMultiplayer } from './Game/MultiplayerV2/AuthoritativeMultiplayer.js'
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
const multiplayerProtocol = String(import.meta.env.VITE_MULTIPLAYER_PROTOCOL ?? '')
let multiplayer = null

if(multiplayerProtocol === '1')
    multiplayer = new Multiplayer(game)
else if(multiplayerProtocol === '2')
    multiplayer = new AuthoritativeMultiplayer(game)

const multiplayerEnabled = [ '1', 'true' ].includes(
    String(import.meta.env.VITE_MULTIPLAYER_ENABLED).toLowerCase(),
)
const multiplayerRoom = resolveRoomFromSearch(window.location.search)

if(multiplayerEnabled && import.meta.env.VITE_SERVER_URL && multiplayerRoom)
{
    if(multiplayer)
        multiplayer.start({ room: multiplayerRoom })
}

if(import.meta.env.VITE_GAME_PUBLIC)
{
    window.game = game
    window.cockpitView = cockpitView
    window.chaseView = chaseView
    window.cameraModeController = cameraModeController
    window.su7FourWheelController = su7FourWheelController
    window.multiplayer = multiplayer
}
