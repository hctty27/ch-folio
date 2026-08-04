import * as THREE from 'three/webgpu'
import cockpitConfig from '../../data/cockpit.generated.json'
import {
    COCKPIT_CAMERA_SETTINGS,
    COCKPIT_VIEW_MODE,
    DEFAULT_COCKPIT_FORWARD_CORRECTION,
    DEFAULT_COCKPIT_REST_PITCH,
    DEFAULT_PHYSICAL_COCKPIT_POSITION,
    computeCockpitPose,
    dampingAlpha,
} from './cockpitPose.js'

const DRIVER_ANCHOR_PATTERN = /(driver.?camera|cockpit.?camera|camera.?anchor|driver.?view)/i
const INTERIOR_PATTERN = /(interior|dashboard|dash|cockpit|steering|seat|windshield|windscreen|glass|door.?trim|pillar|mirror)/i
const GLASS_PATTERN = /(windshield|windscreen|glass)/i
const STEERING_WHEEL_PATTERN = /(steering.?wheel|steeringwheel|volant)/i
const DRIVER_OCCLUDER_PATTERN = /(driver.*head|head.*driver|driver.*body)/i

const IDENTITY_QUATERNION = new THREE.Quaternion()
const X_AXIS = new THREE.Vector3(1, 0, 0)

export class CockpitView
{
    constructor(game)
    {
        this.game = game
        this.active = false
        this.ready = false
        this.pendingActivation = false

        this.settings = {
            ...COCKPIT_CAMERA_SETTINGS,
            lookDamping: 16,
            mouseSensitivity: 0.0022,
            gamepadYawSpeed: 1.8,
            gamepadPitchSpeed: 1.3,
            yawLimit: THREE.MathUtils.degToRad(70),
            pitchUpLimit: THREE.MathUtils.degToRad(30),
            pitchDownLimit: THREE.MathUtils.degToRad(25),
            returnSpeed: 1.8,
            steeringWheelAngle: THREE.MathUtils.degToRad(220),
        }

        this.anchor = {
            source: 'physics-fallback',
            position: DEFAULT_PHYSICAL_COCKPIT_POSITION.clone(),
            quaternion: new THREE.Quaternion(),
            forwardCorrection: DEFAULT_COCKPIT_FORWARD_CORRECTION.clone(),
        }

        this.pose = {
            targetPosition: new THREE.Vector3(),
            targetQuaternion: new THREE.Quaternion(),
            headLookQuaternion: new THREE.Quaternion(),
            headLookEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
        }

        this.look = {
            yaw: 0,
            pitch: DEFAULT_COCKPIT_REST_PITCH,
            targetYaw: 0,
            targetPitch: DEFAULT_COCKPIT_REST_PITCH,
            restPitch: DEFAULT_COCKPIT_REST_PITCH,
            interacting: false,
        }

        this.pointer = {
            id: null,
            x: 0,
            y: 0,
        }

        this.hiddenNodes = []
        this.steeringWheel = null
        this.steeringWheelBaseQuaternion = null
        this.steeringWheelDeltaQuaternion = new THREE.Quaternion()
        this.savedCamera = null
        this.savedViewMode = null
        this.savedDofStrength = null
        this.savedZoomBaseRatio = null

        this.preTickCallback = () =>
        {
            if(this.active && this.game.view?.focusPoint)
                this.game.view.focusPoint.isTracking = true
        }

        this.tickCallback = () => this.update()

        this.installPointerControls()
        this.game.ticker.events.on('tick', this.preTickCallback, 0)
        this.game.ticker.events.on('tick', this.tickCallback, 9)
    }

    installPointerControls()
    {
        const canvas = this.game.canvasElement

        this.onPointerDown = (event) =>
        {
            if(!this.active || this.pointer.id !== null || (event.pointerType === 'mouse' && event.button !== 0))
                return

            if(event.pointerType === 'touch' && this.game.inputs.pointer?.touches?.length < 2)
                return

            this.pointer.id = event.pointerId
            this.pointer.x = event.clientX
            this.pointer.y = event.clientY
            this.look.interacting = true
            canvas.setPointerCapture?.(event.pointerId)
        }

        this.onPointerMove = (event) =>
        {
            if(!this.active || event.pointerId !== this.pointer.id)
                return

            const deltaX = event.clientX - this.pointer.x
            const deltaY = event.clientY - this.pointer.y
            this.pointer.x = event.clientX
            this.pointer.y = event.clientY

            this.look.targetYaw = THREE.MathUtils.clamp(
                this.look.targetYaw - deltaX * this.settings.mouseSensitivity,
                -this.settings.yawLimit,
                this.settings.yawLimit,
            )
            this.look.targetPitch = THREE.MathUtils.clamp(
                this.look.targetPitch - deltaY * this.settings.mouseSensitivity,
                -this.settings.pitchDownLimit,
                this.settings.pitchUpLimit,
            )
        }

        this.onPointerUp = (event) =>
        {
            if(event.pointerId !== this.pointer.id)
                return

            canvas.releasePointerCapture?.(event.pointerId)
            this.pointer.id = null
            this.look.interacting = false
        }

        canvas.addEventListener('pointerdown', this.onPointerDown)
        window.addEventListener('pointermove', this.onPointerMove)
        window.addEventListener('pointerup', this.onPointerUp)
        window.addEventListener('pointercancel', this.onPointerUp)
    }

    tryInitialize()
    {
        const chassis = this.game.world?.visualVehicle?.parts?.chassis

        if(!chassis || !this.game.physicalVehicle || !this.game.view)
            return false

        this.chassis = chassis
        this.chassis.updateMatrixWorld(true)

        const modelAnchor = this.findNode(cockpitConfig.anchorNodeNames, DRIVER_ANCHOR_PATTERN)
        if(modelAnchor)
        {
            const relativeTransform = this.getRelativeTransform(modelAnchor)
            this.anchor.source = modelAnchor.name || 'model-anchor'
            this.anchor.position.copy(relativeTransform.position)
            this.anchor.quaternion.copy(relativeTransform.quaternion)
            this.look.restPitch = 0

            const hasAuthoredRotation = this.anchor.quaternion.angleTo(IDENTITY_QUATERNION) > 0.001
            this.anchor.forwardCorrection.copy(
                modelAnchor.isCamera || hasAuthoredRotation
                    ? IDENTITY_QUATERNION
                    : DEFAULT_COCKPIT_FORWARD_CORRECTION,
            )
        }
        else
        {
            this.anchor.source = 'physics-fallback'
            this.anchor.position.copy(DEFAULT_PHYSICAL_COCKPIT_POSITION)
            this.anchor.quaternion.identity()
            this.anchor.forwardCorrection.copy(DEFAULT_COCKPIT_FORWARD_CORRECTION)
            this.look.restPitch = DEFAULT_COCKPIT_REST_PITCH
        }

        this.interiorNodes = []
        this.hiddenNodes = []
        this.chassis.traverse((child) =>
        {
            const materialNames = Array.isArray(child.material)
                ? child.material.map((material) => material?.name || '').join(' ')
                : child.material?.name || ''
            const searchableName = `${child.name || ''} ${materialNames}`

            if(INTERIOR_PATTERN.test(searchableName))
                this.interiorNodes.push(child)

            if(
                !this.steeringWheel
                && (cockpitConfig.steeringWheelNodeNames.includes(child.name) || STEERING_WHEEL_PATTERN.test(searchableName))
            )
            {
                this.steeringWheel = child
                this.steeringWheelBaseQuaternion = child.quaternion.clone()
            }

            const shouldHideDriver = DRIVER_OCCLUDER_PATTERN.test(searchableName)
            const shouldHideFallbackGlass = this.anchor.source === 'physics-fallback'
                && GLASS_PATTERN.test(searchableName)

            if(shouldHideDriver || shouldHideFallbackGlass)
                this.hiddenNodes.push({ object: child, visible: child.visible })
        })

        this.ready = true

        const readyDetails = {
            anchor: this.anchor.source,
            position: this.anchor.position.toArray(),
            restPitchDegrees: THREE.MathUtils.radToDeg(this.look.restPitch),
            viewMode: COCKPIT_VIEW_MODE,
            camera: COCKPIT_CAMERA_SETTINGS,
            detectedInteriorNodes: cockpitConfig.interiorNodeNames.length,
            runtimeInteriorNodes: this.interiorNodes.length,
            hiddenFallbackNodes: this.hiddenNodes.length,
            steeringWheel: this.steeringWheel?.name || null,
        }
        console.info('[CockpitView] ready', JSON.stringify(readyDetails))

        if(this.pendingActivation)
        {
            this.pendingActivation = false
            this.enter()
        }

        return true
    }

    findNode(configuredNames, pattern)
    {
        for(const name of configuredNames)
        {
            const configuredNode = this.chassis.getObjectByName(name)
            if(configuredNode)
                return configuredNode
        }

        let result = null
        this.chassis.traverse((child) =>
        {
            if(!result && pattern.test(child.name || ''))
                result = child
        })

        return result
    }

    getRelativeTransform(object)
    {
        this.chassis.updateMatrixWorld(true)
        object.updateMatrixWorld(true)

        const relativeMatrix = this.chassis.matrixWorld
            .clone()
            .invert()
            .multiply(object.matrixWorld)

        const position = new THREE.Vector3()
        const quaternion = new THREE.Quaternion()
        const scale = new THREE.Vector3()
        relativeMatrix.decompose(position, quaternion, scale)

        return { position, quaternion }
    }

    toggle()
    {
        return this.active
            ? this.exit()
            : this.enter()
    }

    enter()
    {
        if(this.active)
            return true

        if(this.game.view?.cinematic?.active)
            return false

        if(!this.ready && !this.tryInitialize())
        {
            this.pendingActivation = true
            return false
        }

        const view = this.game.view
        const camera = view.camera
        this.savedCamera = {
            fov: camera.fov,
            near: camera.near,
            zoom: camera.zoom,
        }
        this.savedViewMode = view.mode
        this.savedZoomBaseRatio = view.zoom?.baseRatio ?? null

        view.setMode?.(COCKPIT_VIEW_MODE)
        if(view.zoom)
            view.zoom.toggle = 0

        camera.fov = this.settings.fov
        camera.near = this.settings.near
        camera.zoom = this.settings.zoom
        camera.updateProjectionMatrix()

        const dofStrength = this.game.rendering?.cheapDOFPass?.strength
        this.savedDofStrength = dofStrength?.value ?? null
        if(dofStrength)
            dofStrength.value = 0

        this.look.yaw = 0
        this.look.pitch = this.look.restPitch
        this.look.targetYaw = 0
        this.look.targetPitch = this.look.restPitch
        this.active = true

        for(const item of this.hiddenNodes)
            item.object.visible = false

        document.documentElement.classList.add('is-cockpit-view')
        this.updatePose()

        return true
    }

    exit()
    {
        this.pendingActivation = false

        if(!this.active)
            return false

        this.active = false
        this.look.interacting = false
        this.releasePointer()

        const view = this.game.view
        const camera = view.camera
        if(this.savedCamera)
        {
            camera.fov = this.savedCamera.fov
            camera.near = this.savedCamera.near
            camera.zoom = this.savedCamera.zoom
            camera.updateProjectionMatrix()
        }

        if(view.zoom && this.savedZoomBaseRatio !== null)
        {
            view.zoom.baseRatio = this.savedZoomBaseRatio
            view.zoom.ratio = this.savedZoomBaseRatio
            view.zoom.smoothedRatio = this.savedZoomBaseRatio
            view.zoom.toggle = 0
        }

        for(const item of this.hiddenNodes)
            item.object.visible = item.visible

        const dofStrength = this.game.rendering?.cheapDOFPass?.strength
        if(dofStrength && this.savedDofStrength !== null)
            dofStrength.value = this.savedDofStrength

        const restoreMode = this.savedViewMode ?? view.constructor.MODE_DEFAULT
        view.setMode?.(restoreMode)

        if(restoreMode === view.constructor.MODE_DEFAULT)
        {
            camera.position.copy(view.defaultCamera.position)
            camera.quaternion.copy(view.defaultCamera.quaternion)
            camera.updateMatrixWorld()
        }

        document.documentElement.classList.remove('is-cockpit-view')
        return true
    }

    releasePointer()
    {
        if(this.pointer.id === null)
            return

        this.game.canvasElement.releasePointerCapture?.(this.pointer.id)
        this.pointer.id = null
    }

    update()
    {
        if(!this.ready && !this.tryInitialize())
            return

        this.updateSteeringWheel()

        if(!this.active || this.game.view.cinematic?.active)
            return

        this.updateGamepadLook()
        this.updateLookReturn()
        this.updatePose()
    }

    updateGamepadLook()
    {
        const joystick = this.game.inputs.gamepad?.joysticks?.right
        if(!joystick?.active)
            return

        const delta = this.game.ticker.delta
        this.look.interacting = true
        this.look.targetYaw = THREE.MathUtils.clamp(
            this.look.targetYaw - joystick.x * this.settings.gamepadYawSpeed * delta,
            -this.settings.yawLimit,
            this.settings.yawLimit,
        )
        this.look.targetPitch = THREE.MathUtils.clamp(
            this.look.targetPitch + joystick.y * this.settings.gamepadPitchSpeed * delta,
            -this.settings.pitchDownLimit,
            this.settings.pitchUpLimit,
        )
    }

    updateLookReturn()
    {
        const joystickActive = this.game.inputs.gamepad?.joysticks?.right?.active
        if(!this.look.interacting && !joystickActive)
        {
            const returnAlpha = dampingAlpha(this.settings.returnSpeed, this.game.ticker.delta)
            this.look.targetYaw = THREE.MathUtils.lerp(this.look.targetYaw, 0, returnAlpha)
            this.look.targetPitch = THREE.MathUtils.lerp(
                this.look.targetPitch,
                this.look.restPitch,
                returnAlpha,
            )
        }

        if(this.pointer.id === null && !joystickActive)
            this.look.interacting = false

        const lookAlpha = dampingAlpha(this.settings.lookDamping, this.game.ticker.delta)
        this.look.yaw = THREE.MathUtils.lerp(this.look.yaw, this.look.targetYaw, lookAlpha)
        this.look.pitch = THREE.MathUtils.lerp(this.look.pitch, this.look.targetPitch, lookAlpha)
    }

    updatePose()
    {
        const physicalVehicle = this.game.physicalVehicle

        this.pose.headLookEuler.set(this.look.pitch, this.look.yaw, 0, 'YXZ')
        this.pose.headLookQuaternion.setFromEuler(this.pose.headLookEuler)

        const targetPose = computeCockpitPose({
            vehiclePosition: physicalVehicle.position,
            vehicleQuaternion: physicalVehicle.quaternion,
            localPosition: this.anchor.position,
            anchorQuaternion: this.anchor.quaternion,
            forwardCorrection: this.anchor.forwardCorrection,
            headLookQuaternion: this.pose.headLookQuaternion,
        })

        this.pose.targetPosition.copy(targetPose.position)
        this.pose.targetQuaternion.copy(targetPose.quaternion)

        const camera = this.game.view.camera
        const projectionChanged = camera.fov !== this.settings.fov
            || camera.near !== this.settings.near
            || camera.zoom !== this.settings.zoom

        if(projectionChanged)
        {
            camera.fov = this.settings.fov
            camera.near = this.settings.near
            camera.zoom = this.settings.zoom
            camera.updateProjectionMatrix()
        }

        camera.position.copy(this.pose.targetPosition)
        camera.quaternion.copy(this.pose.targetQuaternion)
        camera.updateMatrixWorld()
    }

    updateSteeringWheel()
    {
        if(!this.steeringWheel || !this.steeringWheelBaseQuaternion)
            return

        const steering = this.game.player?.steering || 0
        this.steeringWheelDeltaQuaternion.setFromAxisAngle(
            X_AXIS,
            -steering * this.settings.steeringWheelAngle,
        )
        this.steeringWheel.quaternion
            .copy(this.steeringWheelBaseQuaternion)
            .multiply(this.steeringWheelDeltaQuaternion)
    }
}
