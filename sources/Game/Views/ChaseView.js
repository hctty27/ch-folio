import * as THREE from 'three/webgpu'

import {
    CHASE_CAMERA_SETTINGS,
    CHASE_VIEW_MODE,
    clampChaseDistance,
    computeChasePose,
    createLookQuaternion,
    dampChasePose,
    returnOrbitToRest,
} from './chasePose.js'
import { dampingAlpha } from './cockpitPose.js'

export class ChaseView
{
    constructor(game)
    {
        this.game = game
        this.active = false
        this.ready = false
        this.pendingActivation = false
        this.poseInitialized = false

        this.settings = {
            ...CHASE_CAMERA_SETTINGS,
            mouseSensitivity: 0.003,
            wheelSensitivity: 0.35,
            gamepadYawSpeed: 1.8,
            gamepadPitchSpeed: 1.2,
            yawLimit: Math.PI,
            pitchMin: THREE.MathUtils.degToRad(-8),
            pitchMax: THREE.MathUtils.degToRad(35),
        }

        this.distance = {
            current: this.settings.distance,
            target: this.settings.distance,
        }

        this.look = {
            yaw: 0,
            pitch: 0,
            targetYaw: 0,
            targetPitch: 0,
            restPitch: 0,
            interacting: false,
        }

        this.pointer = {
            id: null,
            x: 0,
            y: 0,
        }

        this.pose = {
            targetPosition: new THREE.Vector3(),
            targetQuaternion: new THREE.Quaternion(),
        }

        this.savedCamera = null
        this.savedViewMode = null
        this.savedDofStrength = null
        this.savedZoomBaseRatio = null

        this.onZoom = (action) =>
        {
            if(!this.active)
                return

            this.distance.target = clampChaseDistance(
                this.distance.target + action.value * this.settings.wheelSensitivity,
            )
        }

        this.game.inputs.addActions([
            {
                name: 'chaseZoom',
                categories: [ 'wandering', 'racing' ],
                keys: [ 'Wheel.roll' ],
            },
        ])
        this.game.inputs.events.on('chaseZoom', this.onZoom)

        this.installPointerControls()
        this.game.ticker.events.on('tick', () => this.update(), 9)
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
                this.settings.pitchMin,
                this.settings.pitchMax,
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
        if(!this.game.physicalVehicle || !this.game.view)
            return false

        this.ready = true

        if(this.pendingActivation)
        {
            this.pendingActivation = false
            this.enter()
        }

        return true
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

        view.setMode?.(CHASE_VIEW_MODE)
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
        this.distance.current = clampChaseDistance(this.distance.target)
        this.active = true
        this.poseInitialized = false

        document.documentElement.classList.add('is-chase-view')
        this.updatePose(true)

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

        document.documentElement.classList.remove('is-chase-view')
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

        if(!this.active || this.game.view.cinematic?.active)
            return

        this.updateGamepadLook()
        this.updateLookReturn()

        this.distance.current = THREE.MathUtils.lerp(
            this.distance.current,
            this.distance.target,
            dampingAlpha(this.settings.lookDamping, this.game.ticker.delta),
        )

        this.updatePose(false)
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
            this.settings.pitchMin,
            this.settings.pitchMax,
        )
    }

    updateLookReturn()
    {
        const joystickActive = this.game.inputs.gamepad?.joysticks?.right?.active

        if(!this.look.interacting && !joystickActive)
        {
            const returned = returnOrbitToRest({
                yaw: this.look.targetYaw,
                pitch: this.look.targetPitch,
                restPitch: this.look.restPitch,
                damping: this.settings.returnSpeed,
                delta: this.game.ticker.delta,
            })
            this.look.targetYaw = returned.yaw
            this.look.targetPitch = returned.pitch
        }

        if(this.pointer.id === null && !joystickActive)
            this.look.interacting = false

        const lookAlpha = dampingAlpha(this.settings.lookDamping, this.game.ticker.delta)
        this.look.yaw = THREE.MathUtils.lerp(this.look.yaw, this.look.targetYaw, lookAlpha)
        this.look.pitch = THREE.MathUtils.lerp(this.look.pitch, this.look.targetPitch, lookAlpha)
    }

    updatePose(snap = false)
    {
        const physicalVehicle = this.game.physicalVehicle
        const targetPose = computeChasePose({
            vehiclePosition: physicalVehicle.position,
            vehicleQuaternion: physicalVehicle.quaternion,
            distance: this.distance.current,
            height: this.settings.height,
            lookAhead: this.settings.lookAhead,
            targetHeight: this.settings.targetHeight,
            yaw: this.look.yaw,
            pitch: this.look.pitch,
        })

        this.pose.targetPosition.copy(targetPose.position)
        this.pose.targetQuaternion.copy(
            createLookQuaternion(targetPose.position, targetPose.target),
        )

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

        if(snap || !this.poseInitialized)
        {
            camera.position.copy(this.pose.targetPosition)
            camera.quaternion.copy(this.pose.targetQuaternion)
            this.poseInitialized = true
        }
        else
        {
            dampChasePose({
                position: camera.position,
                quaternion: camera.quaternion,
                targetPosition: this.pose.targetPosition,
                targetQuaternion: this.pose.targetQuaternion,
                positionDamping: this.settings.positionDamping,
                rotationDamping: this.settings.rotationDamping,
                delta: this.game.ticker.delta,
            })
        }

        camera.updateMatrixWorld()
    }
}
