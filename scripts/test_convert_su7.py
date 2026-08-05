import unittest

import numpy as np
import trimesh

from convert_su7 import (
    COCKPIT_CAMERA_POSITION,
    TARGET_GROUND_Y,
    WHEEL_GROUPS,
    build_vehicle_scene,
    classify_wheel_groups,
    make_vehicle_transform,
    read_glb_json,
    read_glb_node_names,
    simplify_vertex_clustering,
)


def _box_at(center, extents=(0.2, 0.2, 0.2)):
    mesh = trimesh.creation.box(extents=extents)
    mesh.apply_translation(center)
    return mesh


class ConvertSu7Test(unittest.TestCase):
    @staticmethod
    def _synthetic_source_scene():
        scene = trimesh.Scene()
        centers = [
            (-1.0, 1.0, -4.0),  # front-left
            (1.0, 1.0, 4.0),    # rear-right
            (-1.0, 1.0, 4.0),   # rear-left
            (1.0, 1.0, -4.0),   # front-right
        ]
        for group, center in zip(WHEEL_GROUPS, centers):
            for index, name in enumerate(group):
                extents = (0.2, 1.0, 1.0) if index in (0, 3) else (0.1, 0.7, 0.7)
                scene.add_geometry(
                    _box_at(center, extents),
                    geom_name=name,
                    node_name=name,
                )

        for name in ["Paint1", "Mesh18", "Mesh19", "Mesh20", "Mesh21", "Mesh24"]:
            scene.add_geometry(
                _box_at((0.0, 2.0, 0.0)),
                geom_name=name,
                node_name=name,
            )
        return scene

    def test_vehicle_transform_is_uniform_and_keeps_wheels_round(self):
        transform = make_vehicle_transform(front_z=-4.0, rear_z=4.0, source_ground_y=0.0)
        scales = [np.linalg.norm(transform[:3, axis]) for axis in range(3)]

        self.assertAlmostEqual(scales[0], scales[1])
        self.assertAlmostEqual(scales[1], scales[2])

        mapped = transform @ np.array([0.0, 0.0, -4.0, 1.0])
        np.testing.assert_allclose(mapped[:2], [0.9, TARGET_GROUND_Y], atol=1e-6)

    def test_classifies_all_four_original_wheel_groups(self):
        source = self._synthetic_source_scene()
        transform = make_vehicle_transform(front_z=-4.0, rear_z=4.0, source_ground_y=0.0)
        result = classify_wheel_groups(source, transform)

        self.assertEqual(result["frontRight"], WHEEL_GROUPS[3])
        self.assertEqual(result["frontLeft"], WHEEL_GROUPS[0])
        self.assertEqual(result["rearRight"], WHEEL_GROUPS[1])
        self.assertEqual(result["rearLeft"], WHEEL_GROUPS[2])

    def test_exports_original_four_wheel_hierarchies_without_body_correction(self):
        vehicle = build_vehicle_scene(self._synthetic_source_scene())
        glb = vehicle.export(file_type="glb")
        names = read_glb_node_names(glb)
        required = {
            "chassis",
            "cockpitCamera",
            "bodyPainted",
            "wheelContainer",
            "wheelCylinder",
            "wheelPainted",
            "wheelFrontRight",
            "wheelFrontRightSteer",
            "wheelFrontRightRoll",
            "wheelFrontRightBrake",
            "wheelFrontLeft",
            "wheelFrontLeftSteer",
            "wheelFrontLeftRoll",
            "wheelFrontLeftBrake",
            "wheelRearRight",
            "wheelRearRightRoll",
            "wheelRearRightBrake",
            "wheelRearLeft",
            "wheelRearLeftRoll",
            "wheelRearLeftBrake",
        }

        self.assertTrue(required.issubset(names), required - names)
        self.assertNotIn("bodyVisualCorrection", names)

        document = read_glb_json(glb)
        cockpit = next(node for node in document["nodes"] if node.get("name") == "cockpitCamera")
        matrix = np.array(cockpit["matrix"]).reshape(4, 4, order="F")
        np.testing.assert_allclose(matrix[:3, 3], COCKPIT_CAMERA_POSITION, atol=1e-6)

    def test_exported_tire_geometry_remains_circular_in_rolling_plane(self):
        vehicle = build_vehicle_scene(self._synthetic_source_scene())
        glb = vehicle.export(file_type="glb")
        document = read_glb_json(glb)

        tire_node = next(
            node for node in document["nodes"]
            if node.get("name") == "wheelFrontRightTire0"
        )
        mesh = document["meshes"][tire_node["mesh"]]
        accessor = document["accessors"][mesh["primitives"][0]["attributes"]["POSITION"]]
        extents = np.subtract(accessor["max"], accessor["min"])

        self.assertAlmostEqual(extents[0], extents[1], places=6)
        self.assertLess(extents[2], extents[0])

    def test_vertex_clustering_reduces_faces_without_degenerate_triangles(self):
        mesh = trimesh.creation.icosphere(subdivisions=3)
        simplified = simplify_vertex_clustering(mesh, pitch=0.2)

        self.assertLess(len(simplified.faces), len(mesh.faces))
        self.assertTrue(np.all(
            (simplified.faces[:, 0] != simplified.faces[:, 1])
            & (simplified.faces[:, 1] != simplified.faces[:, 2])
            & (simplified.faces[:, 0] != simplified.faces[:, 2])
        ))


if __name__ == "__main__":
    unittest.main()
