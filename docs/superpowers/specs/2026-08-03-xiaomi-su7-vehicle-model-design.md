# Xiaomi SU7 Vehicle Model Replacement Design

## Goal

Replace the existing stylized vehicle visual with the downloaded Xiaomi SU7 model while preserving the current Rapier vehicle physics, controls, camera behavior, achievements, deployment configuration, and Simplified Chinese localization.

## Source Asset

- Input: Sketchfab Xiaomi SU7 by Mona x Supercars (`ca2cda599f5341068c992c9f44551bf9`).
- License: Creative Commons Attribution (CC BY).
- Downloaded format: OBJ + MTL + PNG textures.
- Geometry: 92,410 triangles, 116,273 source vertices, 84 OBJ groups, 24 materials.
- Original axes: X = width, Y = up, Z = length; vehicle front points toward negative Z.

## Selected Approach

Keep the existing physics vehicle unchanged and adapt only the visual asset.

The SU7 body will be transformed so that:

- vehicle front points toward game +X;
- game +Y remains up;
- vehicle width follows game Z;
- wheel centers align with the existing physics offsets (`x = ±0.90`, `z = ±0.75`);
- wheel radius aligns with the existing physics radius (`0.40`).

The body may use non-uniform longitudinal/lateral scaling to fit the compact game vehicle footprint. Wheel geometry will use uniform scaling to remain circular.

## Required Runtime Hierarchy

The generated GLB must expose these node-name prefixes because `VisualVehicle` resolves parts with regular expressions:

```text
chassis
├── bodyPainted
├── commonBodyParts...
├── blinkerLeft        (optional)
├── blinkerRight       (optional)
├── stopLights         (optional)
├── backLights         (optional)
└── wheelContainer
    └── wheelCylinder
        ├── wheelTire
        └── wheelRimParts...
```

Requirements:

- `chassis` is the visual root synchronized to the Rapier chassis.
- `bodyPainted` is a mesh, not a group, because runtime paint switching assigns its `material` directly.
- `wheelContainer` is one centered wheel template. Runtime code clones it four times.
- `wheelCylinder` is the node rotated by the runtime for wheel spin.
- `wheelPainted` and `wheelSuspension` may be omitted in the first version because the runtime treats them as optional after traversal.
- Antenna and energy-cell nodes are omitted because they do not exist on the SU7 and the current visual code already guards those features.

## Mesh Mapping

- OBJ groups `Paint1` through `Paint7` become the single `bodyPainted` mesh.
- Front-right source wheel groups (`Mesh1` through `Mesh4`) become the reusable wheel template after recentering on their wheel hub.
- The other three source wheel sets (`Mesh5`–`Mesh12`, `Mesh74`–`Mesh77`) are removed from the chassis to avoid duplicate wheels.
- Remaining groups are retained as common body/interior/glass/light meshes and merged by material where safe.
- The original paint material is replaced by a runtime-compatible base material so the existing reward paint system can assign its own TSL material.

## Lighting Scope

Version 1 prioritizes a working vehicle replacement. Separate blinkers, stop lights, and back lights will only be emitted when the relevant source groups can be identified reliably by position/material. Missing optional lights must not prevent loading or driving.

## Asset Outputs

- `static/vehicle/default.glb`: uncompressed generated model.
- `static/vehicle/default-compressed.glb`: Draco/texture-compressed build output compatible with `VITE_COMPRESSED`.
- `static/vehicle/LICENSE-SU7.md`: source attribution, model URL, CC BY notice, and modification statement.
- A deterministic conversion script under `scripts/` so the asset can be regenerated from the downloaded source without manual Blender work.

## Code Compatibility

Prefer no changes to `Game.js`, `PhysicsVehicle.js`, or deployment configuration.

A narrowly-scoped defensive update to `VisualVehicle.js` is allowed only if generated optional nodes expose an existing unchecked assumption. Required nodes (`chassis`, `bodyPainted`, `wheelContainer`, `wheelCylinder`) must be validated during conversion instead of hidden by runtime fallbacks.

## Validation

1. Inspect generated GLB node hierarchy and accessor bounds.
2. Verify required node names exist exactly once.
3. Verify four runtime wheel positions match physics offsets.
4. Verify model front direction is +X and wheel spin axis is Z.
5. Run the production build with `VITE_COMPRESSED` disabled.
6. Run the production build with compressed assets enabled when compression tooling is available.
7. Confirm generated files are below GitHub's per-file limit and reasonable for Cloudflare static delivery.
8. Confirm license attribution is committed with the model.

## Non-goals

- Matching real SU7 dimensions or physics.
- Rebuilding suspension/steering physics.
- Full interior animation, doors, windows, or spoiler animation.
- Photorealistic PBR reconstruction.
- Changing camera, map geometry, controls, or achievements.
