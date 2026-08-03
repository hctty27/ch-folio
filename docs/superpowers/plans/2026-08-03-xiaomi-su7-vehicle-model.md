# Xiaomi SU7 Vehicle Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the default visual vehicle with the downloaded Xiaomi SU7 model while preserving the existing Rapier vehicle physics and runtime effects.

**Architecture:** Convert the source OBJ into a GLB whose scene graph matches `VisualVehicle`'s required node names. Keep physics dimensions unchanged by applying a non-uniform transform that maps the source axle centers to the existing wheelbase, track width, and wheel radius. Store one wheel template for the runtime to clone four times.

**Tech Stack:** Python 3, trimesh, NumPy, glTF 2.0/GLB, Three.js WebGPU, Rapier 3D.

## Global Constraints

- Keep `PhysicsVehicle` parameters unchanged.
- Vehicle forward direction is `+X`, up is `+Y`, and wheel axle is `Z`.
- Required runtime nodes: `chassis`, `bodyPainted`, `wheelContainer`, `wheelCylinder`, and `wheelPainted`.
- Preserve optional runtime lights: `blinkerLeft`, `blinkerRight`, `stopLights`, and `backLights`.
- Keep the source model attribution and CC Attribution license notice in the repository.

---

### Task 1: Conversion Geometry and Scene Graph

**Files:**
- Create: `scripts/convert_su7.py`
- Create: `scripts/test_convert_su7.py`
- Create: `scripts/requirements-su7.txt`

**Interfaces:**
- Consumes: Downloaded OBJ with its MTL and texture files in the same directory.
- Produces: `build_vehicle_scene(source: trimesh.Scene) -> trimesh.Scene` and two GLB files.

- [ ] Write failing tests for axle mapping and required runtime node names.
- [ ] Verify tests fail before the converter exists.
- [ ] Implement coordinate mapping and scene graph generation.
- [ ] Park the source wheel template outside the playable scene so only runtime clones render.
- [ ] Run `python3 -m unittest -v scripts/test_convert_su7.py` and verify all tests pass.

### Task 2: Generate and Validate Vehicle Assets

**Files:**
- Replace: `static/vehicle/default.glb`
- Replace: `static/vehicle/default-compressed.glb`

**Interfaces:**
- Consumes: `scripts/convert_su7.py` and the downloaded source OBJ.
- Produces: GLB 2.0 assets loadable by the existing `GLTFLoader` setup.

- [ ] Generate the uncompressed GLB.
- [ ] Generate a compatible `default-compressed.glb` fallback from the same validated GLB when the external compression CLI is unavailable.
- [ ] Parse both GLB JSON chunks and verify all required node names.
- [ ] Load both files with trimesh and verify valid bounds, meshes, materials, textures, and triangle counts.

### Task 3: Attribution and Delivery

**Files:**
- Create: `static/vehicle/XIAOMI-SU7-ATTRIBUTION.md`

**Interfaces:**
- Consumes: Sketchfab model metadata.
- Produces: Repository-visible source, author, license, and modification notice.

- [ ] Add the author, source model URL, license name, and modification summary.
- [ ] Commit conversion tooling separately from binary assets.
- [ ] Commit generated GLB files to `main`.
- [ ] Confirm the resulting commit and deployment-triggering branch update.
