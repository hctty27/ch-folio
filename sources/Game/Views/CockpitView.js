import * as THREE from 'three/webgpu'
import cockpitConfig from '../../data/cockpit.generated.json'
import {
    DEFAULT_COCKPIT_FORWARD_CORRECTION,
    computeCockpitPose,
    dampCockpitPose,
    dampingAlpha,
} from './cockpitPose.js'

const DRIVER_ANCHOR_PATTERN = /(driver.?camera|cockpit.?camera|camera.?anchor|driver.?view)/i
const INTERIOR_PATTERN = /(interior|dashboard|dash|cockpit|steering|seat|windshield|windscreen|glass|door.?trim|pillar|mirror)/i
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
            fov: 62,
            near: 0.03,
            positionDamping: 20,
            rotationDamping: 24,
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
            source: 'fallback',
            position: new THREE.Vector3(),
            quaternion: new THREE.Quaternion(),
            forwardCorrection: DEFAULT_COCKPIT_FORWARD_CORRECTION.clone(),
        }

        this.pose = {
            targetPosition: new THREE.Vector3(),
            targetQuaternion: new THREE.Quaternion(),
            smoothedPosition: new THREE.Vector3(),
            smoothedQuaternion: new THREE.Quaternion(),
            smoothedInitialized: false,
            headLookQuaternion: new THREE.Quaternion(),
            headLookEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
        }

        this.look = {
            yaw: 0,
            pitch: 0,
            targetYaw: 0,
            targetPitch: 0,
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

        this.onCameraToggle = (action) =>
        {
            if(action.active)
                this.toggle()
        }

        this.preTickCallback = () =>
        {
            if(this.active && this.game.view?.focusPoint)
                this.game.view.focusPoint.isTracking = true
        }

        this.tickCallback = () =>
        {
            this.update()
        }

        this.game.inputs.addActions([
            {
                name: 'cameraToggle',
                categories: [ 'wandering', 'racing' ],
                keys: [ 'Keyboard.KeyC', 'Gamepad.r3' ],
            },
        ])
        this.game.inputs.events.on('cameraToggle', this.onCameraToggle)

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
                - this.settings.yawLimit,
                this.settings.yawLimit,
            )
            this.look.targetPitch = THREE.MathUtils.clamp(
                this.look.targetPitch - deltaY * this.settings.mouseSensitivity,
                - this.settings.pitchDownLimit,
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

            const hasAuthoredRotation = this.anchor.quaternion.angleTo(IDENTITY_QUATERNION) > 0.001
            this.anchor.forwardCorrection.copy(
                modelAnchor.isCamera || hasAuthoredRotation
                    ? IDENTITY_QUATERNION
                    : DEFAULT_COCKPIT_FORWARD_CORRECTION,
            )
        }
        else
        {
            const bounds = this.computeLocalBounds()
            const size = bounds.getSize(new THREE.Vector3())

            this.anchor.source = 'bounds-fallback'
            this.anchor.position.set(
                bounds.min.x + size.x * 0.56,
                bounds.min.y + size.y * 0.72,
                bounds.min.z + size.z * 0.32,
            )
            this.anchor.quaternion.identity()
            this.anchor.forwardCorrection.copy(DEFAULT_COCKPIT_FORWARD_CORRECTION)
        }

        this.interiorNodes = []
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

            if(DRIVER_OCCLUDER_PATTERN.test(searchableName))
                this.hiddenNodes.push({ object: child, visible: child.visible })
        })

        this.ready = true

        console.info('[CockpitView] ready', {
            anchor: this.anchor.source,
            position: this.anchor.position.toArray(),
            detectedInteriorNodes: cockpitConfig.interiorNodeNames.length,
            runtimeInteriorNodes: this.interiorNodes.length,
            steeringWheel: this.steeringWheel?.name || null,
        })

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

    computeLocalBounds()
    {
        const bounds = new THREE.Box3()
        const childBounds = new THREE.Box3()
        const relativeMatrix = new THREE.Matrix4()
        const inverseRootMatrix = this.chassis.matrixWorld.clone().invert()

        this.chassis.traverse((child) =>
        {
            if(!child.isMesh || !child.geometry)
                return

            if(!child.geometry.boundingBox)
                child.geometry.computeBoundingBox()

            if(!child.geometry.boundingBox)
                return

            relativeMatrix.multiplyMatrices(inverseRootMatrix, child.matrixWorld)
            childBounds.copy(child.geometry.boundingBox).applyMatrix4(relativeMatrix)
            bounds.union(childBounds)
        })

        if(bounds.isEmpty())
            bounds.set(new THREE.Vector3(-2, -0.5, -1), new THREE.Vector3(2, 1.5, 1))

        return bounds
    }

    toggle()
    {
        if(!this.ready && !this.tryInitialize())
        {
            this.pendingActivation = !this.pendingActivation
            return
        }

        if(this.active)
            this.exit()
        else
            this.enter()
    }

    enter()
    {
        if(this.active || !this.ready || this.game.view.cinematic?.active)
            return

        const camera = this.game.view.camera
        this.savedCamera = { fov: camera.fov, near: camera.near }
        this.savedViewMode = this.game.view.mode

        if(this.game.view.setMode)
            this.game.view.setMode(this.game.view.constructor.MODE_DEFAULT)

        camera.fov = this.settings.fov
        camera.near = this.settings.near
        camera.updateProjectionMatrix()

        const dofStrength = this.game.rendering?.cheapDOFPass?.strength
        this.savedDofStrength = dofStrength?.value ?? null
        if(dofStrength)
            dofStrength.value = 0

        this.look.yaw = 0
        this.look.pitch = 0
        this.look.targetYaw = 0
        this.look.targetPitch = 0
        this.pose.smoothedInitialized = false
        this.active = true

        for(const item of this.hiddenNodes)
            item.object.visible = false

        document.documentElement.classList.add('is-cockpit-view')
        this.updatePose(true)
    }

    exit()
    {
        if(!this.active)
            return

        this.active = false
        this.pointer.id = null
        this.look.interacting = false
        this.pose.smoothedInitialized = false

        const camera = this.game.view.camera
        if(this.savedCamera)
        {
            camera.fov = this.savedCamera.fov
            camera.near = this.savedCamera.near
            camera.updateProjectionMatrix()
        }

        for(const item of this.hiddenNodes)
            item.object.visible = item.visible

        const dofStrength = this.game.rendering?.cheapDOFPass?.strength
        if(dofStrength && this.savedDofStrength !== null)
            dofStrength.value = this.savedDofStrength

        if(this.savedViewMode !== null && this.game.view.setMode)
            this.game.view.setMode(this.savedViewMode)

        document.documentElement.classList.remove('is-cockpit-view')
    }

    update()
    {
        if(!this.ready && !this.tryInitialize())
            return

        this.updateSteeringWheel()

        if(!this.active)
            return

        if(this.game.view.cinematic?.active)
        {
            this.exit()
            return
        }

        this.updateGamepadLook()
        this.updateLookReturn()
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
            - this.settings.yawLimit,
            this.settings.yawLimit,
        )
        this.look.targetPitch = THREE.MathUtils.clamp(
            this.look.targetPitch + joystick.y * this.settings.gamepadPitchSpeed * delta,
            - this.settings.pitchDownLimit,
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
            this.look.targetPitch = THREE.MathUtils.lerp(this.look.targetPitch, 0, returnAlpha)
        }

        if(this.pointer.id === null && !joystickActive)
            this.look.interacting = false

        const lookAlpha = dampingAlpha(this.settings.lookDamping, this.game.ticker.delta)
        this.look.yaw = THREE.MathUtils.lerp(this.look.yaw, this.look.targetYaw, lookAlpha)
        this.look.pitch = THREE.MathUtils.lerp(this.look.pitch, this.look.targetPitch, lookAlpha)
    }

    updatePose(immediate)
    {
        const physicalVehicle = this.game.physicalVehicle
        const vehiclePosition = physicalVehicle.position
        const vehicleQuaternion = physicalVehicle.quaternion

        this.pose.headLookEuler.set(this.look.pitch, this.look.yaw, 0, 'YXZ')
        this.pose.headLookQuaternion.setFromEuler(this.pose.headLookEuler)

        const targetPose = computeCockpitPose({
            vehiclePosition,
            vehicleQuaternion,
            localPosition: this.anchor.position,
            anchorQuaternion: this.anchor.quaternion,
            forwardCorrection: this.anchor.forwardCorrection,
            headLookQuaternion: this.pose.headLookQuaternion,
        })

        this.pose.targetPosition.copy(targetPose.position)
        this.pose.targetQuaternion.copy(targetPose.quaternion)

        if(immediate || !this.pose.smoothedInitialized)
        {
            this.pose.smoothedPosition.copy(this.pose.targetPosition)
            this.pose.smoothedQuaternion.copy(this.pose.targetQuaternion)
            this.pose.smoothedInitialized = true
        }
        else
        {
            dampCockpitPose({
                position: this.pose.smoothedPosition,
                quaternion: this.pose.smoothedQuaternion,
                targetPosition: this.pose.targetPosition,
                targetQuaternion: this.pose.targetQuaternion,
                positionDamping: this.settings.positionDamping,
                rotationDamping: this.settings.rotationDamping,
                delta: this.game.ticker.delta,
            })
        }

        const camera = this.game.view.camera
        camera.position.copy(this.pose.smoothedPosition)
        camera.quaternion.copy(this.pose.smoothedQuaternion)
        camera.updateMatrixWorld()
    }

    updateSteeringWheel()
    {
        if(!this.steeringWheel || !this.steeringWheelBaseQuaternion)
            return

        const steering = this.game.player?.steering || 0
        this.steeringWheelDeltaQuaternion.setFromAxisAngle(
            X_AXIS,
            - steering * this.settings.steeringWheelAngle,
        )
        this.steeringWheel.quaternion
            .copy(this.steeringWheelBaseQuaternion)
            .multiply(this.steeringWheelDeltaQuaternion)
    }
}
