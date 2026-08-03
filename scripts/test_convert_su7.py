import unittest

import numpy as np
import trimesh

from convert_su7 import (
    build_vehicle_scene,
    make_vehicle_transform,
    read_glb_node_names,
    simplify_vertex_clustering,
)


class ConvertSu7Test(unittest.TestCase):
    def test_vehicle_transform_maps_axles_and_wheel_center_to_game_coordinates(self):
        transform = make_vehicle_transform(
            front_z=-6.801,
            rear_z=5.058,
            side_x=3.35,
            wheel_y=1.423,
        )

        points = np.array([
            [3.35, 1.423, -6.801, 1.0],
            [-3.35, 1.423, 5.058, 1.0],
        ])
        mapped = (transform @ points.T).T[:, :3]

        np.testing.assert_allclose(mapped[0], [0.9, -0.5, 0.75], atol=1e-6)
        np.testing.assert_allclose(mapped[1], [-0.9, -0.5, -0.75], atol=1e-6)

    def test_exported_scene_contains_nodes_required_by_visual_vehicle(self):
        source = self._synthetic_source_scene()
        vehicle = build_vehicle_scene(source)
        glb = vehicle.export(file_type="glb")
        names = read_glb_node_names(glb)

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
        self.assertTrue(required.issubset(names), required - names)

    def test_vertex_clustering_reduces_faces_without_degenerate_triangles(self):
        mesh = trimesh.creation.icosphere(subdivisions=3)
        simplified = simplify_vertex_clustering(mesh, pitch=0.2)

        self.assertLess(len(simplified.faces), len(mesh.faces))
        self.assertTrue(np.all(
            (simplified.faces[:, 0] != simplified.faces[:, 1])
            & (simplified.faces[:, 1] != simplified.faces[:, 2])
            & (simplified.faces[:, 0] != simplified.faces[:, 2])
        ))

    def test_wheel_template_is_parked_outside_the_playable_scene(self):
        source = self._synthetic_source_scene()
        vehicle = build_vehicle_scene(source)
        transform, _ = vehicle.graph.get(frame_to="wheelContainer", frame_from="chassis")

        np.testing.assert_allclose(transform[:3, 3], [1000.0, 0.0, 1000.0], atol=1e-6)

    @staticmethod
    def _synthetic_source_scene():
        scene = trimesh.Scene()
        mesh = trimesh.creation.box(extents=[0.2, 0.2, 0.2])
        names = [
            "Mesh1", "Mesh2", "Mesh3", "Mesh4",
            "Paint1", "Mesh18", "Mesh19", "Mesh20", "Mesh21", "Mesh24",
        ]
        centers = {
            "Mesh1": [3.35, 1.423, -6.801],
            "Mesh2": [3.35, 1.423, -6.801],
            "Mesh3": [3.35, 1.423, -6.801],
            "Mesh4": [3.35, 1.423, -6.801],
        }
        for name in names:
            geometry = mesh.copy()
            geometry.apply_translation(centers.get(name, [0.0, 2.0, 0.0]))
            scene.add_geometry(geometry, geom_name=name, node_name=name)
        return scene


if __name__ == "__main__":
    unittest.main()
