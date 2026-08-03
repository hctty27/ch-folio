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
TARGET_HALF_TRACK = 0.75
TARGET_WHEEL_RADIUS = 0.4
TARGET_WHEEL_Y = -0.5

WHEEL_GROUPS = (
    ("Mesh1", "Mesh2", "Mesh3", "Mesh4"),
    ("Mesh5", "Mesh6", "Mesh7", "Mesh8"),
    ("Mesh9", "Mesh10", "Mesh11", "Mesh12"),
    ("Mesh74", "Mesh75", "Mesh76", "Mesh77"),
)
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


def make_vehicle_transform(
    *,
    front_z: float,
    rear_z: float,
    side_x: float,
    wheel_y: float,
) -> np.ndarray:
    if rear_z <= front_z:
        raise ValueError("rear_z must be greater than front_z")
    if side_x <= 0 or wheel_y <= 0:
        raise ValueError("side_x and wheel_y must be positive")

    longitudinal_scale = (TARGET_HALF_WHEELBASE * 2.0) / (rear_z - front_z)
    lateral_scale = TARGET_HALF_TRACK / side_x
    vertical_scale = TARGET_WHEEL_RADIUS / wheel_y
    axle_midpoint_z = (front_z + rear_z) * 0.5

    transform = np.eye(4)
    transform[0] = [0.0, 0.0, -longitudinal_scale, longitudinal_scale * axle_midpoint_z]
    transform[1] = [0.0, vertical_scale, 0.0, TARGET_WHEEL_Y - vertical_scale * wheel_y]
    transform[2] = [lateral_scale, 0.0, 0.0, 0.0]
    return transform


def _clean_mesh(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    result = mesh.copy()
    result.remove_unreferenced_vertices()
    return result


def _transformed(mesh: trimesh.Trimesh, transform: np.ndarray) -> trimesh.Trimesh:
    result = _clean_mesh(mesh)
    result.apply_transform(transform)
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
        vertices[:, axis] = np.bincount(
            inverse,
            weights=source.vertices[:, axis],
            minlength=vertex_count,
        ) / counts

    faces = inverse[source.faces]
    valid = (
        (faces[:, 0] != faces[:, 1])
        & (faces[:, 1] != faces[:, 2])
        & (faces[:, 0] != faces[:, 2])
    )
    faces = faces[valid]
    if len(faces) == 0:
        return source

    canonical = np.sort(faces, axis=1)
    _, unique_indices = np.unique(canonical, axis=0, return_index=True)
    faces = faces[np.sort(unique_indices)]

    result = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
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
    uv = np.column_stack((
        (mesh.vertices[:, 2] - bounds[0, 2]) / span[2],
        (mesh.vertices[:, 1] - bounds[0, 1]) / span[1],
    ))
    material = trimesh.visual.material.PBRMaterial(
        name=f"su7_{material_name}",
        baseColorFactor=spec["color"],
        metallicFactor=spec["metallic"],
        roughnessFactor=spec["roughness"],
        alphaMode=spec.get("alpha_mode"),
        doubleSided=spec.get("double_sided", False),
    )
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    return mesh


def _prepare_mesh(
    mesh: trimesh.Trimesh,
    transform: np.ndarray,
    *,
    pitch: float,
    material_name: str,
) -> trimesh.Trimesh:
    result = _transformed(mesh, transform)
    if len(result.faces) > 24:
        result = simplify_vertex_clustering(result, pitch=pitch)
    return _set_material(result, material_name)


def _geometry_center(scene: trimesh.Scene, name: str) -> np.ndarray:
    return np.asarray(scene.geometry[name].bounds, dtype=float).mean(axis=0)


def _derive_transform(source: trimesh.Scene) -> np.ndarray:
    tire_names = [group[0] for group in WHEEL_GROUPS if group[0] in source.geometry]
    if len(tire_names) < 2:
        return make_vehicle_transform(
            front_z=-6.801,
            rear_z=5.058,
            side_x=3.35,
            wheel_y=1.423,
        )

    centers = np.array([_geometry_center(source, name) for name in tire_names])
    front_z = float(centers[:, 2].min())
    rear_z = float(centers[:, 2].max())
    side_x = float(np.abs(centers[:, 0]).mean())
    wheel_y = float(centers[:, 1].mean())
    return make_vehicle_transform(
        front_z=front_z,
        rear_z=rear_z,
        side_x=side_x,
        wheel_y=wheel_y,
    )


def _first_complete_wheel_group(source: trimesh.Scene) -> tuple[str, ...]:
    for group in reversed(WHEEL_GROUPS):
        if all(name in source.geometry for name in group):
            return group
    for group in WHEEL_GROUPS:
        available = tuple(name for name in group if name in source.geometry)
        if available:
            return available
    raise ValueError("No supported wheel groups were found in the source model")


def _merge_meshes(meshes: Iterable[trimesh.Trimesh]) -> trimesh.Trimesh:
    items = list(meshes)
    if not items:
        raise ValueError("At least one mesh is required")
    if len(items) == 1:
        return items[0]
    merged = trimesh.util.concatenate(items)
    merged.remove_unreferenced_vertices()
    return merged


def build_vehicle_scene(
    source: trimesh.Scene,
    transform: np.ndarray | None = None,
) -> trimesh.Scene:
    transform = _derive_transform(source) if transform is None else transform
    output = trimesh.Scene()
    output.graph.update(frame_from="world", frame_to="chassis", matrix=np.eye(4))

    wheel_source_names = {name for group in WHEEL_GROUPS for name in group}
    paint_names = sorted(name for name in source.geometry if name.startswith("Paint"))
    special_source_names = set(SPECIAL_GROUPS.values())

    if not paint_names:
        raise ValueError("No Paint* groups found for bodyPainted")

    painted_mesh = _merge_meshes(
        _transformed(source.geometry[name], transform) for name in paint_names
    )
    painted_mesh = simplify_vertex_clustering(painted_mesh, pitch=0.022)
    painted_mesh = _set_material(painted_mesh, "paint")
    output.add_geometry(
        painted_mesh,
        geom_name="bodyPaintedGeometry",
        node_name="bodyPainted",
        parent_node_name="chassis",
    )

    special_materials = {
        "stopLights": "red",
        "blinkerLeft": "orange",
        "blinkerRight": "orange",
        "backLights": "white",
    }
    for runtime_name, source_name in SPECIAL_GROUPS.items():
        if source_name not in source.geometry:
            raise ValueError(f"Required source group {source_name} is missing")
        output.add_geometry(
            _prepare_mesh(
                source.geometry[source_name],
                transform,
                pitch=0.012,
                material_name=special_materials[runtime_name],
            ),
            geom_name=f"{runtime_name}Geometry",
            node_name=runtime_name,
            parent_node_name="chassis",
        )

    excluded = wheel_source_names | set(paint_names) | special_source_names
    common_names = sorted(name for name in source.geometry if name not in excluded)
    common_buckets: dict[str, list[trimesh.Trimesh]] = {}
    for name in common_names:
        source_mesh = source.geometry[name]
        material_name = _material_class(source_mesh)
        prepared = _transformed(source_mesh, transform)
        if len(prepared.faces) > 24:
            prepared = simplify_vertex_clustering(prepared, pitch=0.03)
        common_buckets.setdefault(material_name, []).append(prepared)

    for material_name, meshes in sorted(common_buckets.items()):
        merged = _merge_meshes(meshes)
        merged = _set_material(merged, material_name)
        output.add_geometry(
            merged,
            geom_name=f"commonGeometry_{material_name}",
            node_name=f"common_{material_name}",
            parent_node_name="chassis",
        )

    parked_wheel_template = trimesh.transformations.translation_matrix([1000.0, 0.0, 1000.0])
    output.graph.update(
        frame_from="chassis",
        frame_to="wheelContainer",
        matrix=parked_wheel_template,
    )
    output.graph.update(
        frame_from="wheelContainer",
        frame_to="wheelCylinder",
        matrix=np.eye(4),
    )

    wheel_group = _first_complete_wheel_group(source)
    transformed_wheel = [_transformed(source.geometry[name], transform) for name in wheel_group]
    wheel_center = np.mean([mesh.bounds.mean(axis=0) for mesh in transformed_wheel], axis=0)
    center_transform = trimesh.transformations.translation_matrix(-wheel_center)
    wheel_materials = ("tire", "brake", "wheel", "tire")

    painted_source_name = "Mesh3" if "Mesh3" in wheel_group else wheel_group[0]
    for index, (source_name, mesh) in enumerate(zip(wheel_group, transformed_wheel)):
        mesh.apply_transform(center_transform)
        if len(mesh.faces) > 24:
            mesh = simplify_vertex_clustering(mesh, pitch=0.018)
        material_name = wheel_materials[min(index, len(wheel_materials) - 1)]
        mesh = _set_material(mesh, material_name)
        node_name = "wheelPainted" if source_name == painted_source_name else f"wheelPart_{source_name}"
        output.add_geometry(
            mesh,
            geom_name=f"wheelGeometry_{source_name}",
            node_name=node_name,
            parent_node_name="wheelCylinder",
        )

    return output


def read_glb_json(glb: bytes) -> dict:
    magic, version, length = struct.unpack_from("<4sII", glb, 0)
    if magic != b"glTF" or version != 2 or length != len(glb):
        raise ValueError("Invalid GLB 2.0 header")

    offset = 12
    while offset < length:
        chunk_length, chunk_type = struct.unpack_from("<II", glb, offset)
        offset += 8
        chunk = glb[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == 0x4E4F534A:
            return json.loads(chunk.rstrip(b" \t\r\n\x00"))
    raise ValueError("GLB JSON chunk not found")


def read_glb_node_names(glb: bytes) -> set[str]:
    document = read_glb_json(glb)
    return {node["name"] for node in document.get("nodes", []) if "name" in node}


def convert(source_obj: Path, output_glb: Path, compressed_glb: Path) -> None:
    source = trimesh.load(
        source_obj,
        force="scene",
        process=False,
        maintain_order=True,
        split_groups=True,
        group_material=False,
    )
    if not isinstance(source, trimesh.Scene):
        raise TypeError("Expected OBJ loader to return a trimesh.Scene")

    vehicle = build_vehicle_scene(source)
    glb = vehicle.export(file_type="glb")
    required = {
        "chassis",
        "bodyPainted",
        "wheelContainer",
        "wheelCylinder",
        "wheelPainted",
        "blinkerLeft",
        "blinkerRight",
        "stopLights",
        "backLights",
    }
    missing = required - read_glb_node_names(glb)
    if missing:
        raise ValueError(f"Generated GLB is missing runtime nodes: {sorted(missing)}")

    output_glb.parent.mkdir(parents=True, exist_ok=True)
    output_glb.write_bytes(glb)
    shutil.copyfile(output_glb, compressed_glb)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert the downloaded Xiaomi SU7 OBJ for ch-folio")
    parser.add_argument("source_obj", type=Path)
    parser.add_argument("output_glb", type=Path)
    parser.add_argument("compressed_glb", type=Path)
    args = parser.parse_args()
    convert(args.source_obj, args.output_glb, args.compressed_glb)


if __name__ == "__main__":
    main()
