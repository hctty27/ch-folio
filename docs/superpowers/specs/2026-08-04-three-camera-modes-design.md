# Three Camera Modes Design

## Goal

Add a production-ready open-world chase camera while preserving the existing isometric map camera and cockpit camera. A single camera action cycles through all three modes without conflicting input handlers or leaking camera state.

## User Experience

Press `C` on keyboard or `R3` on gamepad to cycle in this order:

1. `DEFAULT` — existing fixed-angle isometric/map-follow camera.
2. `CHASE` — vehicle-relative third-person chase camera.
3. `COCKPIT` — existing first-person cockpit camera.
4. Back to `DEFAULT`.

The current mode must survive normal driving state changes. Cinematic sequences temporarily take control and return to the previously selected mode when they end.

## Architecture

### CameraModeController

Create `sources/Game/Views/CameraModeController.js` as the only owner of the `cameraToggle` input action.

Responsibilities:

- Register `Keyboard.KeyC` and `Gamepad.r3` once.
- Maintain the selected mode enum: `DEFAULT`, `CHASE`, `COCKPIT`.
- Exit the active specialized view before entering the next one.
- Delegate default-camera restoration to `View`.
- Prevent transitions while a cinematic camera is active.
- Expose the selected mode for debugging and future UI indicators.

### ChaseView

Create `sources/Game/Views/ChaseView.js`.

Responsibilities:

- Read the physical vehicle/chassis world transform each frame.
- Compute a target point slightly ahead of the vehicle center.
- Compute the ideal camera position behind and above the vehicle.
- Apply frame-rate-independent position and rotation damping.
- Support pointer orbit while active.
- Support wheel distance adjustment within configured limits.
- Return yaw smoothly toward the vehicle rear after the user stops orbiting.
- Save and restore camera projection values and depth-of-field state.
- Keep the original map camera disabled while active.

Initial chase settings:

- Distance: `7.0`
- Height: `2.8`
- Look-ahead: `3.0`
- FOV: `55`
- Near plane: `0.1`
- Distance range: `4.5` to `11.0`
- Position damping: `7`
- Rotation damping: `6`
- Orbit return speed: `2.5`

The vehicle forward axis must be derived from the chassis quaternion and validated against the SU7 model orientation rather than assumed blindly.

### CockpitView Changes

`CockpitView` keeps its camera behavior, pointer look, interior visibility handling, and steering-wheel animation. It no longer registers or listens for `cameraToggle`. It exposes explicit `enter()`, `exit()`, and readiness methods for `CameraModeController`.

### View Changes

Add a specialized external-camera mode or equivalent guard so `View.update()` does not overwrite the final camera transform while `CHASE` or `COCKPIT` is active.

`View` remains responsible for:

- Existing default isometric camera.
- Existing debug free camera.
- Focus-point and map controls.
- Default camera restoration.

Map dragging and default zoom input must be ignored while chase or cockpit mode is active.

## Input Ownership

The controller owns `C` and `R3`. This removes the existing conflict where `R3` is both a zoom toggle and cockpit toggle.

Recommended behavior:

- `C` / `R3`: cycle camera mode.
- Mouse wheel in `DEFAULT`: existing map zoom.
- Mouse wheel in `CHASE`: chase distance.
- Mouse wheel in `COCKPIT`: no camera-mode side effect.
- Pointer drag in `CHASE`: orbit.
- Pointer drag in `COCKPIT`: head look.

## State Transitions

Every specialized view must save and restore:

- Camera `fov`, `near`, and `zoom`.
- Depth-of-field strength.
- View mode and zoom state.
- Any hidden vehicle nodes.
- Pointer capture and interaction state.

Transition sequence:

1. Exit active specialized view.
2. Restore a clean default camera baseline.
3. Enter the selected specialized view if needed.
4. Apply the new camera pose immediately to avoid a one-frame flash.

## Collision Handling

Phase one implements the full chase behavior without scene collision shortening, keeping the change isolated and testable.

The chase module will expose a camera-distance resolver boundary so raycast-based obstruction handling can be added without changing the controller. A follow-up can raycast from the look target toward the desired camera position and shorten the distance when an obstruction is found.

## Testing

Add unit tests for pure chase-camera math and state transitions:

- Vehicle transform produces the expected rear/upper camera target.
- Different frame deltas produce stable damping behavior.
- Orbit yaw clamps and returns toward zero.
- Distance clamps to configured limits.
- Camera mode cycle order is deterministic.
- Entering one specialized mode exits the previous one.
- Cockpit no longer owns the toggle input.
- Default view state is fully restored after each mode.

Run the existing cockpit tests, new camera tests, and production build before completion.

## Acceptance Criteria

- `C` and `R3` cycle `DEFAULT → CHASE → COCKPIT → DEFAULT` exactly once per press.
- Chase camera stays behind the SU7, follows turns smoothly, supports orbit and zoom, and recenters after interaction.
- Existing map camera behavior remains unchanged in `DEFAULT`.
- Existing cockpit behavior remains unchanged in `COCKPIT`.
- No double input registration or `R3` conflict remains.
- Switching modes does not leave incorrect FOV, zoom, DOF, hidden meshes, or pointer state.
- Existing tests, new tests, and production build pass.

## Deferred Scope

- Camera collision/occlusion shortening.
- Dynamic speed-based FOV.
- Camera shake and terrain-aware height correction.
- On-screen camera-mode indicator.
