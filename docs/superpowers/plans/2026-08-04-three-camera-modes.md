# Three Camera Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a smooth vehicle-relative chase camera and cycle `DEFAULT → CHASE → COCKPIT → DEFAULT` through one input owner.

**Architecture:** Keep the existing `View` as the default map-camera owner. Add pure chase-camera math, a runtime `ChaseView`, and a `CameraModeController` that exclusively owns `C`/`R3`; `CockpitView` becomes an explicitly entered/exited specialized view. Specialized modes use numeric view modes that cause `View.update()` to leave the final camera transform untouched.

**Tech Stack:** JavaScript ES modules, Three.js 0.183, Node.js built-in test runner, Vite 7.

## Global Constraints

- Preserve existing default map camera behavior.
- Preserve existing cockpit rendering, head look, hidden-node handling, and steering animation.
- `C` and `Gamepad.r3` must be registered exactly once.
- Initial chase distance is `7.0`, height `2.8`, look-ahead `3.0`, FOV `55`, near plane `0.1`.
- Chase distance clamps from `4.5` to `11.0`.
- Phase one does not add obstruction raycasting.

---

### Task 1: Pure camera mode and chase pose behavior

**Files:**
- Create: `sources/Game/Views/cameraModes.js`
- Create: `sources/Game/Views/chasePose.js`
- Create: `scripts/test_camera_modes.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `CAMERA_MODES`, `CAMERA_MODE_ORDER`, `nextCameraMode(mode)`.
- Produces: `CHASE_VIEW_MODE`, `CHASE_CAMERA_SETTINGS`, `computeChasePose(options)`, `clampChaseDistance(value)`, `dampChasePose(options)`, and `returnOrbitToRest(options)`.

- [ ] **Step 1: Write failing tests** for deterministic mode cycling, identity/rotated vehicle chase placement, distance clamping, orbit return, and frame-rate-independent pose damping.
- [ ] **Step 2: Run** `node --test scripts/test_camera_modes.mjs` and confirm failure because the production modules do not exist.
- [ ] **Step 3: Implement the minimal pure modules** using cloned `Vector3`/`Quaternion` values and `dampingAlpha`.
- [ ] **Step 4: Run** `node --test scripts/test_camera_modes.mjs` and confirm all tests pass.
- [ ] **Step 5: Add the new test file to the package `test` script.**

### Task 2: Runtime chase camera

**Files:**
- Create: `sources/Game/Views/ChaseView.js`
- Modify: `scripts/test_camera_modes.mjs`

**Interfaces:**
- Consumes: pure functions and settings from `chasePose.js`.
- Produces: `new ChaseView(game)`, `tryInitialize()`, `enter()`, `exit()`, `update()`.

- [ ] **Step 1: Extend the failing test** to require chase input names and explicit lifecycle methods in `ChaseView.js`.
- [ ] **Step 2: Run the camera test and confirm the source-contract test fails.**
- [ ] **Step 3: Implement `ChaseView`** with physical-vehicle transform following, pointer/two-touch orbit, right-stick orbit, wheel distance adjustment, automatic yaw/pitch return, immediate first pose, damped later poses, and complete camera/DOF restoration.
- [ ] **Step 4: Run the camera test and confirm it passes.**

### Task 3: Unified input ownership and cockpit lifecycle

**Files:**
- Create: `sources/Game/Views/CameraModeController.js`
- Modify: `sources/Game/Views/CockpitView.js`
- Modify: `scripts/test_camera_modes.mjs`

**Interfaces:**
- Consumes: `CAMERA_MODES`, `nextCameraMode`, `ChaseView`, `CockpitView`.
- Produces: `new CameraModeController(game, { chaseView, cockpitView })`, `cycle()`, `setMode(mode)`, `update()`.

- [ ] **Step 1: Add failing source-contract tests** proving `CameraModeController` owns `Keyboard.KeyC` and `Gamepad.r3`, while `CockpitView` no longer registers `cameraToggle`.
- [ ] **Step 2: Run the camera test and confirm failure.**
- [ ] **Step 3: Remove toggle input registration/conflict mutation from `CockpitView`; make `enter()` initialize or queue activation, return success, and make `exit()` cancel queued activation.**
- [ ] **Step 4: Implement `CameraModeController`** with exact cycle order, clean exit-before-enter transitions, cinematic suspension, and post-cinematic restoration.
- [ ] **Step 5: Run camera and cockpit tests and confirm they pass.**

### Task 4: Integrate with the base view and application bootstrap

**Files:**
- Modify: `sources/Game/View.js`
- Modify: `sources/index.js`
- Modify: `scripts/test_camera_modes.mjs`

**Interfaces:**
- `View.MODE_DEFAULT = 1`, `View.MODE_FREE = 2`, `View.MODE_COCKPIT = 3`, `View.MODE_CHASE = 4`.
- Application exposes `window.chaseView` and `window.cameraModeController` when `VITE_GAME_PUBLIC` is enabled.

- [ ] **Step 1: Add failing tests** requiring external mode constants, removal of `R3` from default zoom, and application construction of all three view components.
- [ ] **Step 2: Run the camera test and confirm failure.**
- [ ] **Step 3: Update `View`** so default wheel zoom only mutates in default mode, remove the `R3` zoom-toggle binding, and declare external mode constants.
- [ ] **Step 4: Update `sources/index.js`** to construct `CockpitView`, `ChaseView`, and `CameraModeController` in that order.
- [ ] **Step 5: Run all tests.**

### Task 5: Verification

**Files:**
- Verify all files above.

- [ ] **Step 1: Run** `npm test`.
- [ ] **Step 2: Run** `npm run build`.
- [ ] **Step 3: Inspect committed source** for one `cameraToggle` action registration, correct mode order, and no leftover `R3` zoom binding.
- [ ] **Step 4: Review the final diff** for projection/DOF restoration, pointer cleanup, queued activation cancellation, and no unrelated changes.
