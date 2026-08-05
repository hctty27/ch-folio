#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import struct
from pathlib import Path
from typing import Iterable

import numpy as np
import trimesh

TARGET_HALF_WHEELBASE = 0.9
TARGET_GROUND_Y = -0.98
COCKPIT_CAMERA_POSITION = np.array([0.22, -0.30, 0.0], dtype=float)
WHEEL_GROUPS = (
    ("Mesh1", "Mesh2", "Mesh3", "Mesh4"),
    ("Mesh5", "Mesh6", "Mesh7", "Mesh8"),
    ("Mesh9", "Mesh10", "Mesh11", "Mesh12"),
    ("Mesh74", "Mesh75", "Mesh76", "Mesh77"),
)
WHEEL_PART_ROLES = ("tire", "brake", "rim", "tire")
WHEEL_NODE_NAMES = {
    "frontRight": "wheelFrontRight",
    "frontLeft": "wheelFrontLeft",
    "rearRight": "wheelRearRight",
    "rearLeft": "wheelRearLeft",
}
SPECIAL_GROUPS = {
    "stopLights": "Mesh18",
    "blinkerLeft": "Mesh19",
    "blinkerRight": "Mesh20",
    "backLights": "Mesh21",
}
MATERIAL_SPECS = {
    "paint": {"color": [0.72, 0.74, 0.78, 1.0], "metallic": 0.25, "roughness": 0.32},
    "dark": {"color": [0.035, 0.04, 0.05, 1.0], "metallic": 0.15, "roughness": 0.55},
    "body": {"color": [0.16, 0.17, 0.19, 1.0], "metallic": 0.15, "roughness": 0.58},
    "glass": {"color": [0.025, 0.055, 0.075, 0.42], "metallic": 0.0, "roughness": 0.12, "alpha_mode": "BLEND", "double_sided": True},
    "chrome": {"color": [0.62, 0.66, 0.7, 1.0], "metallic": 0.78, "roughness": 0.22},
    "red": {"color": [0.72, 0.018, 0.012, 1.0], "metallic": 0.0, "roughness": 0.3},
    "orange": {"color": [1.0, 0.22, 0.015, 1.0], "metallic": 0.0, "roughness": 0.25},
    "white": {"color": [0.95, 0.97, 1.0, 1.0], "metallic": 0.0, "roughness": 0.2},
    "tire": {"color": [0.012, 0.014, 0.016, 1.0], "metallic": 0.0, "roughness": 0.88},
    "brake": {"color": [0.34, 0.36, 0.39, 1.0], "metallic": 0.72, "roughness": 0.35},
    "wheel": {"color": [0.09, 0.1, 0.12, 1.0], "metallic": 0.72, "roughness": 0.28},
}


def _clean_mesh(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    result = mesh.copy()
    result.remove_unreferenced_vertices()
    return result


def _transformed(mesh: trimesh.Trimesh, transform: np.ndarray) -> trimesh.Trimesh:
    result = _clean_mesh(mesh)
    result.apply_transform(transform)
    return result


def _geometry_center(scene: trimesh.Scene, name: str) -> np.ndarray:
    return np.asarray(scene.geometry[name].bounds, dtype=float).mean(axis=0)


def _complete_wheel_groups(source: trimesh.Scene) -> list[tuple[str, ...]]:
    groups = [group for group in WHEEL_GROUPS if all(name in source.geometry for name in group)]
    if len(groups) != 4:
        raise ValueError(f"Expected 4 complete wheel groups, found {len(groups)}")
    return groups


def _source_group_center(source: trimesh.Scene, group: tuple[str, ...]) -> np.ndarray:
    return np.mean([_geometry_center(source, name) for name in group], axis=0)


def make_vehicle_transform(*, front_z: float, rear_z: float, source_ground_y: float = 0.0) -> np.ndarray:
    if rear_z <= front_z:
        raise ValueError("rear_z must be greater than front_z")
    scale = (TARGET_HALF_WHEELBASE * 2.0) / (rear_z - front_z)
    axle_midpoint_z = (front_z + rear_z) * 0.5
    transform = np.eye(4)
    # Source: X lateral, Y up, Z longitudinal. Runtime: X forward, Y up, Z lateral.
    transform[0] = [0.0, 0.0, -scale, scale * axle_midpoint_z]
    transform[1] = [0.0, scale, 0.0, TARGET_GROUND_Y - scale * source_ground_y]
    transform[2] = [scale, 0.0, 0.0, 0.0]
    return transform


def _derive_transform(source: trimesh.Scene) -> np.ndarray:
    groups = _complete_wheel_groups(source)
    centers = np.array([_source_group_center(source, group) for group in groups])
    front_z = float(centers[:, 2].min())
    rear_z = float(centers[:, 2].max())
    tire_names = [group[0] for group in groups]
    source_ground_y = float(min(source.geometry[name].bounds[0, 1] for name in tire_names))
    return make_vehicle_transform(front_z=front_z, rear_z=rear_z, source_ground_y=source_ground_y)


def _transformed_group_center(source: trimesh.Scene, group: tuple[str, ...], transform: np.ndarray) -> np.ndarray:
    return np.mean([
        _transformed(source.geometry[name], transform).bounds.mean(axis=0)
        for name in group
    ], axis=0)


def classify_wheel_groups(source: trimesh.Scene, transform: np.ndarray) -> dict[str, tuple[str, ...]]:
    items = [(group, _transformed_group_center(source, group, transform)) for group in _complete_wheel_groups(source)]
    front = sorted(items, key=lambda item: item[1][0], reverse=True)[:2]
    rear = sorted(items, key=lambda item: item[1][0])[:2]
    if abs(front[0][1][0] - rear[0][1][0]) < 1e-4:
        raise ValueError("Wheel groups could not be uniquely classified")

    def right_left(pair):
        ordered = sorted(pair, key=lambda item: item[1][2])
        if abs(ordered[-1][1][2] - ordered[0][1][2]) < 1e-4:
            raise ValueError("Wheel groups could not be uniquely classified")
        return ordered[-1][0], ordered[0][0]

    front_right, front_left = right_left(front)
    rear_right, rear_left = right_left(rear)
    result = {
        "frontRight": front_right,
        "frontLeft": front_left,
        "rearRight": rear_right,
        "rearLeft": rear_left,
    }
    if len(set(result.values())) != 4:
        raise ValueError("Wheel groups could not be uniquely classified")
    return result


def simplify_vertex_clustering(mesh: trimesh.Trimesh, pitch: float) -> trimesh.Trimesh:
    if pitch <= 0:
        raise ValueError("pitch must be positive")
    source = _clean_mesh(mesh)
    keys = np.floor(source.vertices / pitch + 0.5).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    vertex_count = int(inverse.max()) + 1
    vertices = np.zeros((vertex_count, 3), dtype=np.float64)
    counts = np.bincount(inverse, minlength=vertex_count).astype(np.float64)
    for axis in range(3):
        vertices[:, axis] = np.bincount(inverse, weights=source.vertices[:, axis], minlength=vertex_count) / counts
    faces = inverse[source.faces]
    valid = ((faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2]))
    faces = faces[valid]
    if len(faces) == 0:
        return source
    canonical = np.sort(faces, axis=1)
    _, unique_indices = np.unique(canonical, axis=0, return_index=True)
    result = trimesh.Trimesh(vertices=vertices, faces=faces[np.sort(unique_indices)], process=False)
    result.remove_unreferenced_vertices()
    return result


def _material_class(mesh: trimesh.Trimesh) -> str:
    name = getattr(getattr(mesh.visual, "material", None), "name", "")
    if name in {"Mesh26Mtl", "Mesh32Mtl", "Mesh71Mtl"}:
        return "glass"
    if name in {"Mesh61Mtl", "Mesh62Mtl", "Mesh68Mtl"}:
        return "chrome"
    if name in {"Mesh17Mtl", "Mesh60Mtl"}:
        return "red"
    if name in {"Mesh19Mtl", "Mesh30Mtl", "Mesh35Mtl", "Mesh72Mtl"}:
        return "dark"
    return "body"


def _set_material(mesh: trimesh.Trimesh, material_name: str) -> trimesh.Trimesh:
    spec = MATERIAL_SPECS[material_name]
    bounds = mesh.bounds
    span = np.maximum(bounds[1] - bounds[0], 1e-6)
    uv = np.column_stack(((mesh.vertices[:, 2] - bounds[0, 2]) / span[2], (mesh.vertices[:, 1] - bounds[0, 1]) / span[1]))
    mesh.visual = trimesh.visual.TextureVisuals(
        uv=uv,
        material=trimesh.visual.material.PBRMaterial(
            name=f"su7_{material_name}",
            baseColorFactor=spec["color"],
            metallicFactor=spec["metallic"],
            roughnessFactor=spec["roughness"],
            alphaMode=spec.get("alpha_mode"),
            doubleSided=spec.get("double_sided", False),
        ),
    )
    return mesh


def _merge_meshes(meshes: Iterable[trimesh.Trimesh]) -> trimesh.Trimesh:
    items = list(meshes)
    if not items:
        raise ValueError("At least one mesh is required")
    merged = items[0] if len(items) == 1 else trimesh.util.concatenate(items)
    merged.remove_unreferenced_vertices()
    return merged


def _add_empty(output: trimesh.Scene, parent: str, name: str, translation: np.ndarray | None = None) -> None:
    matrix = np.eye(4)
    if translation is not None:
        matrix[:3, 3] = translation
    output.graph.update(frame_from=parent, frame_to=name, matrix=matrix)


def _add_wheel_hierarchy(output: trimesh.Scene, *, slot: str, source_names: tuple[str, ...], source: trimesh.Scene, transform: np.ndarray) -> None:
    root_name = WHEEL_NODE_NAMES[slot]
    meshes = [_transformed(source.geometry[name], transform) for name in source_names]
    center = np.mean([mesh.bounds.mean(axis=0) for mesh in meshes], axis=0)
    _add_empty(output, "chassis", root_name, center)
    parent = root_name
    if slot.startswith("front"):
        parent = f"{root_name}Steer"
        _add_empty(output, root_name, parent)
    roll_name = f"{root_name}Roll"
    brake_name = f"{root_name}Brake"
    _add_empty(output, parent, roll_name)
    _add_empty(output, parent, brake_name)

    for index, (source_name, role, mesh) in enumerate(zip(source_names, WHEEL_PART_ROLES, meshes)):
        mesh.apply_translation(-center)
        # Geometry is retained at source fidelity; only the coordinate-system transform is baked.
        material_name = "wheel" if role == "rim" else role
        mesh = _set_material(mesh, material_name)
        if role == "brake":
            node_name = f"{root_name}BrakePart"
            parent_name = brake_name
        elif role == "rim":
            node_name = f"wheelPainted_{slot}"
            parent_name = roll_name
        else:
            node_name = f"{root_name}Tire{index}"
            parent_name = roll_name
        output.add_geometry(mesh, geom_name=f"{node_name}Geometry", node_name=node_name, parent_node_name=parent_name)


def _add_legacy_template(output: trimesh.Scene, *, source_names: tuple[str, ...], source: trimesh.Scene, transform: np.ndarray) -> None:
    _add_empty(output, "chassis", "wheelContainer", np.array([1000.0, 0.0, 1000.0]))
    _add_empty(output, "wheelContainer", "wheelCylinder")
    meshes = [_transformed(source.geometry[name], transform) for name in source_names]
    center = np.mean([mesh.bounds.mean(axis=0) for mesh in meshes], axis=0)
    for source_name, role, mesh in zip(source_names, WHEEL_PART_ROLES, meshes):
        mesh.apply_translation(-center)
        material_name = "wheel" if role == "rim" else role
        mesh = _set_material(mesh, material_name)
        node_name = "wheelPainted" if role == "rim" else f"wheelPart_{source_name}"
        output.add_geometry(mesh, geom_name=f"legacyWheelGeometry_{source_name}", node_name=node_name, parent_node_name="wheelCylinder")


def build_vehicle_scene(source: trimesh.Scene, transform: np.ndarray | None = None) -> trimesh.Scene:
    transform = _derive_transform(source) if transform is None else transform
    output = trimesh.Scene()
    output.graph.update(frame_from="world", frame_to="chassis", matrix=np.eye(4))
    _add_empty(output, "chassis", "cockpitCamera", COCKPIT_CAMERA_POSITION)

    wheel_groups = classify_wheel_groups(source, transform)
    wheel_source_names = {name for group in WHEEL_GROUPS for name in group}
    paint_names = sorted(name for name in source.geometry if name.startswith("Paint"))
    special_source_names = set(SPECIAL_GROUPS.values())
    if not paint_names:
        raise ValueError("No Paint* groups found for bodyPainted")

    # Paint panels remain a single mesh because runtime color switching targets bodyPainted.material.
    painted = _merge_meshes(_transformed(source.geometry[name], transform) for name in paint_names)
    painted = _set_material(painted, "paint")
    output.add_geometry(painted, geom_name="bodyPaintedGeometry", node_name="bodyPainted", parent_node_name="chassis")

    special_materials = {"stopLights": "red", "blinkerLeft": "orange", "blinkerRight": "orange", "backLights": "white"}
    for runtime_name, source_name in SPECIAL_GROUPS.items():
        if source_name not in source.geometry:
            raise ValueError(f"Required source group {source_name} is missing")
        mesh = _set_material(_transformed(source.geometry[source_name], transform), special_materials[runtime_name])
        output.add_geometry(mesh, geom_name=f"{runtime_name}Geometry", node_name=runtime_name, parent_node_name="chassis")

    excluded = wheel_source_names | set(paint_names) | special_source_names
    counters: dict[str, int] = {}
    for source_name in sorted(name for name in source.geometry if name not in excluded):
        mesh = _transformed(source.geometry[source_name], transform)
        material_class = _material_class(mesh)
        counters[material_class] = counters.get(material_class, 0) + 1
        # Named glass nodes keep cockpit detection working while preserving source geometry.
        node_name = f"common_{material_class}_{counters[material_class]}_{source_name}"
        output.add_geometry(mesh, geom_name=f"{node_name}Geometry", node_name=node_name, parent_node_name="chassis")

    for slot in ("frontRight", "frontLeft", "rearRight", "rearLeft"):
        _add_wheel_hierarchy(output, slot=slot, source_names=wheel_groups[slot], source=source, transform=transform)
    _add_legacy_template(output, source_names=wheel_groups["frontLeft"], source=source, transform=transform)
    return output


def read_glb_json(glb: bytes) -> dict:
    magic, version, length = struct.unpack_from("<4sII", glb, 0)
    if magic != b"glTF" or version != 2 or length != len(glb):
        raise ValueError("Invalid GLB 2.0 header")
    offset = 12
    while offset < length:
        chunk_length, chunk_type = struct.unpack_from("<II", glb, offset)
        offset += 8
        chunk = glb[offset:offset + chunk_length]
        offset += chunk_length
        if chunk_type == 0x4E4F534A:
            return json.loads(chunk.rstrip(b" \t\r\n\x00"))
    raise ValueError("GLB JSON chunk not found")


def read_glb_node_names(glb: bytes) -> set[str]:
    return {node["name"] for node in read_glb_json(glb).get("nodes", []) if "name" in node}


def convert(source_obj: Path, output_glb: Path, compressed_glb: Path) -> None:
    source = trimesh.load(source_obj, force="scene", process=False, maintain_order=True, split_groups=True, group_material=False)
    if not isinstance(source, trimesh.Scene):
        raise TypeError("Expected OBJ loader to return a trimesh.Scene")
    vehicle = build_vehicle_scene(source)
    glb = vehicle.export(file_type="glb")
    required = {
        "chassis", "cockpitCamera", "bodyPainted", "wheelContainer", "wheelCylinder", "wheelPainted",
        "blinkerLeft", "blinkerRight", "stopLights", "backLights",
        "wheelFrontRight", "wheelFrontRightSteer", "wheelFrontRightRoll", "wheelFrontRightBrake",
        "wheelFrontLeft", "wheelFrontLeftSteer", "wheelFrontLeftRoll", "wheelFrontLeftBrake",
        "wheelRearRight", "wheelRearRightRoll", "wheelRearRightBrake",
        "wheelRearLeft", "wheelRearLeftRoll", "wheelRearLeftBrake",
    }
    missing = required - read_glb_node_names(glb)
    if missing:
        raise ValueError(f"Generated GLB is missing runtime nodes: {sorted(missing)}")
    output_glb.parent.mkdir(parents=True, exist_ok=True)
    output_glb.write_bytes(glb)
    shutil.copyfile(output_glb, compressed_glb)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert the original Xiaomi SU7 OBJ for ch-folio")
    parser.add_argument("source_obj", type=Path)
    parser.add_argument("output_glb", type=Path)
    parser.add_argument("compressed_glb", type=Path)
    args = parser.parse_args()
    convert(args.source_obj, args.output_glb, args.compressed_glb)


if __name__ == "__main__":
    main()
