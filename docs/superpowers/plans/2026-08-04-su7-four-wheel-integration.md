# SU7 Four-Wheel Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve all four original Xiaomi SU7 wheel groups during conversion and drive them as independent front-right, front-left, rear-right, and rear-left visual wheels without changing the existing Rapier vehicle physics.

**Architecture:** The Python conversion pipeline will classify the four source wheel groups by transformed center, emit a fixed glTF node hierarchy with separate steering and rolling pivots, and bake every wheel so its runtime roll axis is local `Z`. The Three.js runtime will prefer those four named wheel nodes, map them to the existing physical-wheel indices, and retain the current cloned-template implementation only as an explicit compatibility fallback.

**Tech Stack:** Python 3, NumPy, trimesh, glTF/GLB, Node.js test runner, Three.js 0.183.x, Vite 7, Rapier3D.

## Global Constraints

- Do not modify Rapier wheel radius, suspension, friction, grip, wheelbase, track width, or vehicle control behavior.
- Do not modify cockpit-camera files or camera parameters.
- Physical-wheel index mapping remains `0 = front-right`, `1 = front-left`, `2 = rear-right`, `3 = rear-left`.
- Runtime roll axis is local `Z`; conversion must bake geometry and initial orientation to satisfy that contract.
- Front wheels have separate steering and rolling pivots; rear wheels have rolling pivots only.
- Brake/caliper geometry must not be parented below the rolling pivot.
- New four-wheel mode is the primary path; the old `wheelContainer` clone path remains only as a warning-backed compatibility fallback.
- Conversion must fail clearly when four complete, distinguishable wheel groups cannot be produced.
- No new wheel geometry, tire branding, textures, physical dimensions, or unrelated refactors.

---

## File Structure

- Modify `scripts/convert_su7.py` — classify four source wheel groups, normalize their geometry, and emit the new glTF node hierarchy.
- Create `scripts/test_convert_su7.py` — Python unit coverage for classification, hierarchy, roll-axis normalization, and failure cases.
- Create `sources/Game/World/SU7WheelNodes.js` — focused runtime discovery and physical-index mapping for the four named wheel nodes.
- Create `scripts/test_su7_wheel_nodes.mjs` — Node tests for runtime discovery, mapping, and fallback detection.
- Modify `sources/Game/World/VisualVehicle.js` — consume four independent wheel nodes, update steering/rolling/suspension, and preserve the old clone fallback.
- Modify `package.json` — expose focused Python and JavaScript wheel tests and include both in the main test command.
- Regenerate `static/vehicle/default.glb` and `static/vehicle/default-compressed.glb` through the existing asset pipeline.

---

### Task 1: Add deterministic four-wheel classification helpers

**Files:**
- Modify: `scripts/convert_su7.py`
- Create: `scripts/test_convert_su7.py`
- Modify: `package.json`

**Interfaces:**
- Produces: `classify_wheel_groups(source: trimesh.Scene, transform: np.ndarray) -> dict[str, tuple[str, ...]]`
- Produces keys exactly: `frontRight`, `frontLeft`, `rearRight`, `rearLeft`.
- Consumes existing constants: `WHEEL_GROUPS`, `TARGET_HALF_WHEELBASE`, `TARGET_HALF_TRACK`, `TARGET_WHEEL_Y`.

- [ ] **Step 1: Write the failing classification test**

Create `scripts/test_convert_su7.py` with a synthetic scene whose four wheel-group centers are unambiguous after the identity transform:

```python
from __future__ import annotations

import unittest

import numpy as np
import trimesh

from convert_su7 import WHEEL_GROUPS, classify_wheel_groups


def _box_at(center: tuple[float, float, float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.box(extents=(0.2, 0.2, 0.2))
    mesh.apply_translation(center)
    return mesh


def _scene_with_four_groups() -> trimesh.Scene:
    scene = trimesh.Scene()
    centers = {
        WHEEL_GROUPS[0]: (0.9, -0.5, 0.75),
        WHEEL_GROUPS[1]: (0.9, -0.5, -0.75),
        WHEEL_GROUPS[2]: (-0.9, -0.5, 0.75),
        WHEEL_GROUPS[3]: (-0.9, -0.5, -0.75),
    }
    for group, center in centers.items():
        for index, name in enumerate(group):
            mesh = _box_at((center[0], center[1], center[2] + index * 0.001))
            scene.add_geometry(mesh, geom_name=name, node_name=name)
    return scene


class ClassifyWheelGroupsTest(unittest.TestCase):
    def test_classifies_four_physical_indices(self) -> None:
        result = classify_wheel_groups(_scene_with_four_groups(), np.eye(4))

        self.assertEqual(result["frontRight"], WHEEL_GROUPS[0])
        self.assertEqual(result["frontLeft"], WHEEL_GROUPS[1])
        self.assertEqual(result["rearRight"], WHEEL_GROUPS[2])
        self.assertEqual(result["rearLeft"], WHEEL_GROUPS[3])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
python3 -m unittest scripts/test_convert_su7.py -v
```

Expected: import failure because `classify_wheel_groups` does not exist.

- [ ] **Step 3: Implement the minimal classifier**

Add focused helpers to `scripts/convert_su7.py`:

```python
WHEEL_SLOT_NAMES = ("frontRight", "frontLeft", "rearRight", "rearLeft")


def _complete_wheel_groups(source: trimesh.Scene) -> list[tuple[str, ...]]:
    groups = [group for group in WHEEL_GROUPS if all(name in source.geometry for name in group)]
    if len(groups) != 4:
        raise ValueError(f"Expected 4 complete wheel groups, found {len(groups)}")
    return groups


def _transformed_group_center(
    source: trimesh.Scene,
    group: tuple[str, ...],
    transform: np.ndarray,
) -> np.ndarray:
    centers = []
    for name in group:
        mesh = _transformed(source.geometry[name], transform)
        centers.append(mesh.bounds.mean(axis=0))
    return np.mean(centers, axis=0)


def classify_wheel_groups(
    source: trimesh.Scene,
    transform: np.ndarray,
) -> dict[str, tuple[str, ...]]:
    groups = _complete_wheel_groups(source)
    items = [(group, _transformed_group_center(source, group, transform)) for group in groups]

    front = sorted(items, key=lambda item: item[1][0], reverse=True)[:2]
    rear = sorted(items, key=lambda item: item[1][0])[:2]

    def right_left(pair):
        right = max(pair, key=lambda item: item[1][2])
        left = min(pair, key=lambda item: item[1][2])
        return right[0], left[0]

    front_right, front_left = right_left(front)
    rear_right, rear_left = right_left(rear)
    result = {
        "frontRight": front_right,
        "frontLeft": front_left,
        "rearRight": rear_right,
        "rearLeft": rear_left,
    }
    if len({group for group in result.values()}) != 4:
        raise ValueError("Wheel groups could not be uniquely classified")
    return result
```

Use the converted vehicle coordinate convention already established by `make_vehicle_transform`: longitudinal `X`, height `Y`, lateral `Z`.

- [ ] **Step 4: Add failure tests**

Add tests that assert:

```python
def test_rejects_missing_wheel_group(self) -> None:
    scene = _scene_with_four_groups()
    del scene.geometry[WHEEL_GROUPS[3][0]]
    with self.assertRaisesRegex(ValueError, "Expected 4 complete wheel groups"):
        classify_wheel_groups(scene, np.eye(4))
```

Add a second case where two group centers are identical and require `classify_wheel_groups` to raise `ValueError("Wheel groups could not be uniquely classified")` after adding an explicit front/rear and left/right separation tolerance of `1e-4`.

- [ ] **Step 5: Run focused Python tests and verify GREEN**

Run:

```bash
python3 -m unittest scripts/test_convert_su7.py -v
```

Expected: all classification and error tests pass.

- [ ] **Step 6: Add the focused package script**

Modify `package.json` scripts:

```json
"test:su7-convert": "python3 -m unittest scripts/test_convert_su7.py -v"
```

Do not add it to the main `test` command until Task 4, when the runtime tests also exist.

- [ ] **Step 7: Commit**

```bash
git add scripts/convert_su7.py scripts/test_convert_su7.py package.json
git commit -m "test: classify four SU7 wheel groups"
```

---

### Task 2: Emit four independent steering and rolling hierarchies

**Files:**
- Modify: `scripts/convert_su7.py`
- Modify: `scripts/test_convert_su7.py`

**Interfaces:**
- Consumes: `classify_wheel_groups(...)` from Task 1.
- Produces nodes exactly named:
  - `wheelFrontRight`, `wheelFrontRightSteer`, `wheelFrontRightRoll`, `wheelFrontRightBrake`
  - `wheelFrontLeft`, `wheelFrontLeftSteer`, `wheelFrontLeftRoll`, `wheelFrontLeftBrake`
  - `wheelRearRight`, `wheelRearRightRoll`, `wheelRearRightBrake`
  - `wheelRearLeft`, `wheelRearLeftRoll`, `wheelRearLeftBrake`
- Produces rollable child meshes below `*Roll`; brake/caliper meshes remain outside `*Roll`.

- [ ] **Step 1: Write a failing hierarchy test**

Add a test that calls `build_vehicle_scene()` with a synthetic body plus four complete wheel groups and asserts the exact node names are present:

```python
def test_builds_four_named_wheel_hierarchies(self) -> None:
    source = _scene_with_four_groups_and_body()
    output = build_vehicle_scene(source, np.eye(4))
    names = set(output.graph.nodes)

    expected = {
        "wheelFrontRight", "wheelFrontRightSteer", "wheelFrontRightRoll", "wheelFrontRightBrake",
        "wheelFrontLeft", "wheelFrontLeftSteer", "wheelFrontLeftRoll", "wheelFrontLeftBrake",
        "wheelRearRight", "wheelRearRightRoll", "wheelRearRightBrake",
        "wheelRearLeft", "wheelRearLeftRoll", "wheelRearLeftBrake",
    }
    self.assertTrue(expected.issubset(names))
    self.assertNotIn("wheelContainer", names)
```

The fixture must also add the required `Paint*` and light groups currently required by `build_vehicle_scene()`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
python3 -m unittest scripts/test_convert_su7.py -v
```

Expected: failure because output still contains only `wheelContainer / wheelCylinder`.

- [ ] **Step 3: Replace the single-template emission block**

Remove the block beginning with:

```python
parked_wheel_template = trimesh.transformations.translation_matrix([1000.0, 0.0, 1000.0])
```

and replace it with a helper-driven loop:

```python
WHEEL_NODE_NAMES = {
    "frontRight": "wheelFrontRight",
    "frontLeft": "wheelFrontLeft",
    "rearRight": "wheelRearRight",
    "rearLeft": "wheelRearLeft",
}


def _wheel_center(meshes: list[trimesh.Trimesh]) -> np.ndarray:
    return np.mean([mesh.bounds.mean(axis=0) for mesh in meshes], axis=0)


def _add_wheel_hierarchy(
    output: trimesh.Scene,
    *,
    slot: str,
    source_names: tuple[str, ...],
    source: trimesh.Scene,
    transform: np.ndarray,
) -> None:
    root_name = WHEEL_NODE_NAMES[slot]
    source_meshes = [_transformed(source.geometry[name], transform) for name in source_names]
    center = _wheel_center(source_meshes)
    root_matrix = trimesh.transformations.translation_matrix(center)
    output.graph.update(frame_from="chassis", frame_to=root_name, matrix=root_matrix)

    parent_name = root_name
    if slot.startswith("front"):
        steer_name = f"{root_name}Steer"
        output.graph.update(frame_from=root_name, frame_to=steer_name, matrix=np.eye(4))
        parent_name = steer_name

    roll_name = f"{root_name}Roll"
    brake_name = f"{root_name}Brake"
    output.graph.update(frame_from=parent_name, frame_to=roll_name, matrix=np.eye(4))
    output.graph.update(frame_from=parent_name, frame_to=brake_name, matrix=np.eye(4))
```

For each source mesh, translate geometry by `-center` before output. Assign tire/rim meshes below `roll_name`; assign the identified brake/caliper mesh below `brake_name`.

- [ ] **Step 4: Make part assignment explicit**

Add a constant matching the current source-group ordering:

```python
WHEEL_PART_ROLES = ("tire", "brake", "rim", "tire")
```

For each `(source_name, role)`:

- `role == "brake"` → parent `*Brake`, material `brake`.
- `role == "rim"` → parent `*Roll`, material `wheel`, node suffix `Rim`.
- `role == "tire"` → parent `*Roll`, material `tire`, node suffix `Tire{index}`.

Preserve `wheelPainted` semantics by naming the rim mesh `wheelPainted_<slot>` so `VisualVehicle.setPaints()` can still find painted wheel material targets.

- [ ] **Step 5: Bake the runtime roll axis**

Before attaching wheel geometry, compute the group’s current width axis from bounds. Because the converted vehicle uses lateral `Z`, bake any required corrective rotation into each local mesh so the axle aligns with local `Z`, then verify the roll pivot itself remains identity rotation.

Add a pure helper:

```python
def rotation_to_local_z(axle: np.ndarray) -> np.ndarray:
    axle = axle / np.linalg.norm(axle)
    target = np.array([0.0, 0.0, 1.0])
    return trimesh.geometry.align_vectors(axle, target)
```

Apply this transform around the wheel center to the wheel meshes only; do not rotate the root translation or physical placement.

- [ ] **Step 6: Add hierarchy and axis tests**

Assert:

```python
self.assertEqual(output.graph.transforms.parents["wheelFrontRightRoll"], "wheelFrontRightSteer")
self.assertEqual(output.graph.transforms.parents["wheelRearRightRoll"], "wheelRearRight")
self.assertNotEqual(output.graph.transforms.parents["wheelFrontRightBrake"], "wheelFrontRightRoll")
```

Also inspect each rollable geometry’s local bounds and assert its smallest extent is `Z` within `1e-4`, proving local `Z` is the axle direction.

- [ ] **Step 7: Add wheel-position tolerance checks**

After all four wheels are emitted, compare root translations against:

```python
EXPECTED_WHEEL_POSITIONS = {
    "frontRight": np.array([0.9, -0.5, 0.75]),
    "frontLeft": np.array([0.9, -0.5, -0.75]),
    "rearRight": np.array([-0.9, -0.5, 0.75]),
    "rearLeft": np.array([-0.9, -0.5, -0.75]),
}
```

Raise a slot-specific `ValueError` when Euclidean error exceeds `0.08` model units. This validates conversion without changing physical positions.

- [ ] **Step 8: Run Python tests and verify GREEN**

```bash
npm run test:su7-convert
```

Expected: all conversion tests pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/convert_su7.py scripts/test_convert_su7.py
git commit -m "feat: preserve four SU7 wheel hierarchies"
```

---

### Task 3: Add runtime discovery and physical-index mapping

**Files:**
- Create: `sources/Game/World/SU7WheelNodes.js`
- Create: `scripts/test_su7_wheel_nodes.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `getSU7WheelDescriptors(chassis) -> Array<WheelDescriptor> | null`
- `WheelDescriptor` shape:

```js
{
    slot: 'frontRight' | 'frontLeft' | 'rearRight' | 'rearLeft',
    physicalIndex: 0 | 1 | 2 | 3,
    root: THREE.Object3D,
    steer: THREE.Object3D | null,
    roll: THREE.Object3D,
    brake: THREE.Object3D,
    painted: THREE.Object3D | null,
}
```

- [ ] **Step 1: Write failing Node tests**

Create `scripts/test_su7_wheel_nodes.mjs` using small fake objects with `getObjectByName()`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { getSU7WheelDescriptors } from '../sources/Game/World/SU7WheelNodes.js'

function fakeChassis(missing = null)
{
    const names = [
        'wheelFrontRight', 'wheelFrontRightSteer', 'wheelFrontRightRoll', 'wheelFrontRightBrake',
        'wheelFrontLeft', 'wheelFrontLeftSteer', 'wheelFrontLeftRoll', 'wheelFrontLeftBrake',
        'wheelRearRight', 'wheelRearRightRoll', 'wheelRearRightBrake',
        'wheelRearLeft', 'wheelRearLeftRoll', 'wheelRearLeftBrake',
    ]
    const map = new Map(names.filter((name) => name !== missing).map((name) => [name, { name, traverse() {} }]))
    return { getObjectByName: (name) => map.get(name) ?? null }
}

test('maps four SU7 wheel nodes to physical indices', () =>
{
    const descriptors = getSU7WheelDescriptors(fakeChassis())
    assert.deepEqual(descriptors.map(({ slot, physicalIndex }) => ({ slot, physicalIndex })), [
        { slot: 'frontRight', physicalIndex: 0 },
        { slot: 'frontLeft', physicalIndex: 1 },
        { slot: 'rearRight', physicalIndex: 2 },
        { slot: 'rearLeft', physicalIndex: 3 },
    ])
})

test('returns null when a required wheel node is missing', () =>
{
    assert.equal(getSU7WheelDescriptors(fakeChassis('wheelRearLeftRoll')), null)
})
```

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/test_su7_wheel_nodes.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the descriptor module**

Create `sources/Game/World/SU7WheelNodes.js`:

```js
const DEFINITIONS = [
    { slot: 'frontRight', physicalIndex: 0, root: 'wheelFrontRight', steer: 'wheelFrontRightSteer', roll: 'wheelFrontRightRoll', brake: 'wheelFrontRightBrake' },
    { slot: 'frontLeft', physicalIndex: 1, root: 'wheelFrontLeft', steer: 'wheelFrontLeftSteer', roll: 'wheelFrontLeftRoll', brake: 'wheelFrontLeftBrake' },
    { slot: 'rearRight', physicalIndex: 2, root: 'wheelRearRight', steer: null, roll: 'wheelRearRightRoll', brake: 'wheelRearRightBrake' },
    { slot: 'rearLeft', physicalIndex: 3, root: 'wheelRearLeft', steer: null, roll: 'wheelRearLeftRoll', brake: 'wheelRearLeftBrake' },
]

function findPainted(root)
{
    let painted = null
    root.traverse?.((child) =>
    {
        if(!painted && /^wheelPainted_/i.test(child.name))
            painted = child
    })
    return painted
}

export function getSU7WheelDescriptors(chassis)
{
    const descriptors = DEFINITIONS.map((definition) =>
    {
        const root = chassis?.getObjectByName?.(definition.root) ?? null
        const steer = definition.steer ? chassis?.getObjectByName?.(definition.steer) ?? null : null
        const roll = chassis?.getObjectByName?.(definition.roll) ?? null
        const brake = chassis?.getObjectByName?.(definition.brake) ?? null
        if(!root || !roll || !brake || (definition.steer && !steer))
            return null
        return { ...definition, root, steer, roll, brake, painted: findPainted(root) }
    })
    return descriptors.some((descriptor) => descriptor === null) ? null : descriptors
}
```

- [ ] **Step 4: Add painted-node and rear-steer tests**

Verify front descriptors have non-null `steer`, rear descriptors have `steer === null`, and `wheelPainted_frontRight` is returned when present beneath the root.

- [ ] **Step 5: Add package scripts**

Modify `package.json`:

```json
"test:su7-wheels": "node --test scripts/test_su7_wheel_nodes.mjs"
```

- [ ] **Step 6: Run tests and verify GREEN**

```bash
npm run test:su7-wheels
```

Expected: all runtime-discovery tests pass.

- [ ] **Step 7: Commit**

```bash
git add sources/Game/World/SU7WheelNodes.js scripts/test_su7_wheel_nodes.mjs package.json
git commit -m "test: map SU7 wheel nodes to physics"
```

---

### Task 4: Drive four independent visual wheels in `VisualVehicle`

**Files:**
- Modify: `sources/Game/World/VisualVehicle.js`
- Modify: `scripts/test_su7_wheel_nodes.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getSU7WheelDescriptors(chassis)`.
- Preserves existing `this.wheels.items[i]`, `groundTrack`, `painted`, `container`, and `suspension` expectations where possible.
- Adds: `this.wheels.mode` with values `'su7-four-wheel'` or `'legacy-template'`.

- [ ] **Step 1: Add a failing mode-selection test**

Extend `SU7WheelNodes.js` with a pure selector so runtime mode can be tested without constructing `VisualVehicle`:

```js
export function selectWheelMode(chassis)
{
    const descriptors = getSU7WheelDescriptors(chassis)
    return descriptors ? { mode: 'su7-four-wheel', descriptors } : { mode: 'legacy-template', descriptors: null }
}
```

Write tests for both outcomes first, run them, and verify failure because `selectWheelMode` does not exist.

- [ ] **Step 2: Implement mode selection and verify GREEN**

Run:

```bash
npm run test:su7-wheels
```

Expected: all tests pass.

- [ ] **Step 3: Import the descriptor helper**

Add to `VisualVehicle.js`:

```js
import { selectWheelMode } from './SU7WheelNodes.js'
```

- [ ] **Step 4: Split wheel setup into two focused methods**

Replace the single `setWheels()` body with:

```js
setWheels()
{
    this.wheels = { items: [], steering: 0, mode: null }
    const selection = selectWheelMode(this.parts.chassis)

    if(selection.mode === 'su7-four-wheel')
        this.setSU7Wheels(selection.descriptors)
    else
        this.setLegacyWheels()
}
```

Move the existing clone-based code unchanged into `setLegacyWheels()`, including `wheel.cylinder.position.set(0, 0, 0)` and left-side mirroring. Set `this.wheels.mode = 'legacy-template'` and emit one warning:

```js
console.warn('[VisualVehicle] Four SU7 wheel nodes are missing; using legacy wheel template fallback')
```

Do not attempt to repair the legacy rotation behavior in this task.

- [ ] **Step 5: Implement `setSU7Wheels()`**

Create one runtime item per descriptor:

```js
setSU7Wheels(descriptors)
{
    this.wheels.mode = 'su7-four-wheel'
    for(const descriptor of descriptors)
    {
        const wheel = {
            container: descriptor.root,
            suspension: null,
            cylinder: descriptor.roll,
            roll: descriptor.roll,
            steer: descriptor.steer,
            brake: descriptor.brake,
            painted: descriptor.painted,
            physicalIndex: descriptor.physicalIndex,
            baseRoll: descriptor.roll.rotation.z,
            rollAngle: 0,
            groundTrack: this.game.tracks.add(new Track(0.5, 'r')),
        }
        this.wheels.items[descriptor.physicalIndex] = wheel
    }
}
```

The converted root already contains the correct local wheel position. Do not clone, mirror, clear position, or overwrite initial quaternion.

- [ ] **Step 6: Branch the per-frame wheel update by mode**

Keep the existing steering interpolation and `wheelsRotation` calculation. For each item:

```js
if(this.wheels.mode === 'su7-four-wheel')
{
    if(visualWheel.steer)
        visualWheel.steer.rotation.y = this.wheels.steering

    if(!brakingLock)
    {
        visualWheel.rollAngle += wheelsRotation
        visualWheel.roll.rotation.z = visualWheel.baseRoll + visualWheel.rollAngle
    }

    visualWheel.container.position.x = physicalWheel.basePosition.x
    visualWheel.container.position.y += (wheelY - visualWheel.container.position.y) * 25 * this.game.ticker.deltaScaled
    visualWheel.container.position.z = physicalWheel.basePosition.z
}
else
{
    // retain the existing legacy index-specific rotation and steering code unchanged
}
```

Define once before the branch:

```js
const brakingLock = this.game.inputs.actions.get('brake').active
    && !this.game.inputs.actions.get('forward').active
    && !this.game.inputs.actions.get('backward').active
```

All four converted wheels share the same baked local `Z` roll axis, so do not alternate the roll sign by side in SU7 mode.

- [ ] **Step 7: Preserve paint switching**

Retain the existing loop in `setPaints()`:

```js
for(const wheel of this.wheels.items)
{
    if(wheel.painted)
        wheel.painted.material = material
}
```

Add a runtime-discovery test showing each descriptor returns its own painted rim node. No additional material traversal is required.

- [ ] **Step 8: Preserve ground tracks and destruction**

Verify every SU7 item owns exactly one `groundTrack`, and the existing `destroy()` loop removes all four. Keep track updates indexed by `physicalIndex` through `this.wheels.items[0..3]`.

- [ ] **Step 9: Add both wheel suites to the main test command**

Modify `package.json`:

```json
"test": "npm run test:js && npm run test:su7-convert",
"test:js": "node --test scripts/test_materialize_vehicle.mjs scripts/test_cockpit_pose.mjs scripts/test_su7_wheel_nodes.mjs",
"test:su7-convert": "python3 -m unittest scripts/test_convert_su7.py -v",
"test:su7-wheels": "node --test scripts/test_su7_wheel_nodes.mjs"
```

Retain existing `test:vehicle` and `test:cockpit` entries.

- [ ] **Step 10: Run focused and full tests**

```bash
npm run test:su7-wheels
npm run test:su7-convert
npm test
```

Expected: every command exits `0` with no failing tests.

- [ ] **Step 11: Commit**

```bash
git add sources/Game/World/VisualVehicle.js sources/Game/World/SU7WheelNodes.js scripts/test_su7_wheel_nodes.mjs package.json
git commit -m "feat: drive four independent SU7 wheels"
```

---

### Task 5: Regenerate assets and verify the browser behavior

**Files:**
- Regenerate: `static/vehicle/default.glb`
- Regenerate: `static/vehicle/default-compressed.glb`
- Modify only if required by the existing pipeline: `scripts/materialize-vehicle.js`, asset hash/checksum metadata, or split chunks.

**Interfaces:**
- Consumes the updated `scripts/convert_su7.py`.
- Produces deployable GLBs containing all required named nodes.

- [ ] **Step 1: Identify the existing asset-generation command from repository scripts**

Use the current materialization/conversion entrypoint; do not manually edit GLB bytes. The command must invoke `scripts/convert_su7.py` against the preserved source asset and write both runtime targets.

- [ ] **Step 2: Generate both GLB files**

Run the repository’s existing SU7 conversion/materialization command. If it is not exposed in `package.json`, execute the exact Python entrypoint already used by the project and record it in the commit message body.

Expected converter output must include four slots:

```text
frontRight
frontLeft
rearRight
rearLeft
```

- [ ] **Step 3: Add a generated-GLB structure assertion**

Extend `scripts/test_convert_su7.py` with a test that reads the generated GLB JSON chunk through the existing `read_glb_json()` helper and asserts all required node names are present exactly once.

```python
required = {
    "wheelFrontRight", "wheelFrontRightSteer", "wheelFrontRightRoll", "wheelFrontRightBrake",
    "wheelFrontLeft", "wheelFrontLeftSteer", "wheelFrontLeftRoll", "wheelFrontLeftBrake",
    "wheelRearRight", "wheelRearRightRoll", "wheelRearRightBrake",
    "wheelRearLeft", "wheelRearLeftRoll", "wheelRearLeftBrake",
}
node_names = [node.get("name") for node in glb_json["nodes"]]
for name in required:
    self.assertEqual(node_names.count(name), 1)
```

- [ ] **Step 4: Run the full verification commands**

```bash
npm test
npm run build
```

Expected: both commands exit `0`. Confirm the existing Cloudflare size guard still passes and no generated file exceeds the configured deployment limit.

- [ ] **Step 5: Inspect the generated scene in a browser**

Deploy or run the local production preview and verify:

1. Four wheels sit at their correct wheel-arch centers while stationary.
2. Forward motion rotates all four wheels around their axles only.
3. Reverse motion rotates them in the opposite direction.
4. Front wheels steer; rear wheels do not steer.
5. Wheel side faces never flip into horizontal or diagonal discs.
6. Brake/caliper geometry does not rotate with tire/rim geometry.
7. Suspension movement changes wheel-root height without changing roll axis.
8. Cockpit mode and third-person mode remain otherwise unchanged.
9. Console contains no legacy-fallback warning.

- [ ] **Step 6: Inspect GLB node names through runtime diagnostics**

With `VITE_GAME_PUBLIC` enabled, verify in the browser console:

```js
[
  'wheelFrontRight', 'wheelFrontLeft', 'wheelRearRight', 'wheelRearLeft'
].map((name) => [name, Boolean(window.game.resources.vehicle.scene.getObjectByName(name))])
```

Expected: all four entries are `true`.

- [ ] **Step 7: Commit regenerated assets**

```bash
git add static/vehicle/default.glb static/vehicle/default-compressed.glb scripts/test_convert_su7.py
git commit -m "asset: preserve four original SU7 wheels"
```

- [ ] **Step 8: Final diff review**

Compare the implementation branch against the design commit and confirm the diff contains only:

- conversion helpers/tests,
- four-wheel runtime discovery/tests,
- `VisualVehicle` wheel-path changes,
- package test scripts,
- regenerated vehicle assets.

Reject unrelated cockpit, physics, scenery, localization, or deployment changes.
