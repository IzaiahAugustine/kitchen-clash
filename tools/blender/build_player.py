"""Builds the Kitchen Clash cartoon player and exports it as a .glb.

Run via `npm run models`. Units are feet. The character is authored in game coordinates
(see build_court.py): standing at the origin, facing -z (toward the far court), right hand +x.

The skeleton is a hierarchy of empties named j_* (joints). Body parts are rigidly parented
to them, and the game animates the joints procedurally so swings line up exactly with
ball contact. Joints carry no rotation, so in the game a joint's local axes match the
character's: rotating about +x swings a hanging limb forward.

Material names are palette slots the game recolors per player:
  skin, shirt, shorts, cap, shoe, sock, paddle, grip, eye_white, pupil
Object prefixes: ol_ = gets a cartoon outline, flat_ = no outline.
"""

import os
import sys

import bpy

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(args[0] if args else "player.glb")

COLORS = {
    "skin": "#f1c27d",
    "shirt": "#ff6b35",
    "shorts": "#2b2d42",
    "cap": "#ffd23f",
    "shoe": "#f5f5f5",
    "sock": "#ffffff",
    "paddle": "#e63946",
    "grip": "#1b1530",
    "eye_white": "#ffffff",
    "pupil": "#1b1530",
}


def G(x, y, z):
    return (x, -z, y)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def srgb_to_linear(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


_materials = {}


def mat(key):
    if key in _materials:
        return _materials[key]
    h = COLORS[key].lstrip("#")
    rgb = [srgb_to_linear(int(h[i:i + 2], 16)) for i in (0, 2, 4)]
    m = bpy.data.materials.new(key)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new(
            "ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    m.diffuse_color = (*rgb, 1.0)
    _materials[key] = m
    return m


def joint(name, parent, offset):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.15
    scene.collection.objects.link(e)
    e.parent = parent
    e.location = G(*offset)
    return e


def _finish(ob, name, parent, offset, material, smooth=True):
    ob.name = name
    ob.data.name = name
    ob.parent = parent
    ob.location = G(*offset)
    ob.data.materials.clear()
    ob.data.materials.append(mat(material))
    for p in ob.data.polygons:
        p.use_smooth = smooth
    return ob


def ell(name, parent, center, radii, material, subdiv=3):
    """Ellipsoid (radii in game x, y, z) centered at `center` in the parent joint's space."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20 if subdiv >= 3 else 14, ring_count=12 if subdiv >= 3 else 8,
                                         radius=1.0, location=(0, 0, 0))
    ob = bpy.context.active_object
    rx, ry, rz = radii
    ob.scale = (rx, rz, ry)
    return _finish(ob, name, parent, center, material)


def cyl(name, parent, center, radius, depth, material, axis="y", scale=(1, 1, 1), verts=20):
    """Cylinder along game `axis` ('y' or 'z')."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=(0, 0, 0))
    ob = bpy.context.active_object
    if axis == "z":
        ob.rotation_euler = (1.5707963, 0, 0)  # Blender Z -> game +z
    ob.scale = scale
    return _finish(ob, name, parent, center, material)


# ---------------------------------------------------------------- skeleton

root = joint("j_root", None, (0, 0, 0))
hips = joint("j_hips", root, (0, 2.35, 0))
spine = joint("j_spine", hips, (0, 0.1, 0))
neck = joint("j_neck", spine, (0, 1.75, 0))
sh_r = joint("j_shoulder_R", spine, (0.78, 1.45, 0))
el_r = joint("j_elbow_R", sh_r, (0, -0.8, 0))
hand_r = joint("j_hand_R", el_r, (0, -0.75, 0))
sh_l = joint("j_shoulder_L", spine, (-0.78, 1.45, 0))
el_l = joint("j_elbow_L", sh_l, (0, -0.8, 0))
hand_l = joint("j_hand_L", el_l, (0, -0.75, 0))
hip_r = joint("j_hip_R", hips, (0.32, -0.15, 0))
knee_r = joint("j_knee_R", hip_r, (0, -1.1, 0))
hip_l = joint("j_hip_L", hips, (-0.32, -0.15, 0))
knee_l = joint("j_knee_L", hip_l, (0, -1.1, 0))

# ---------------------------------------------------------------- body

ell("ol_shorts", hips, (0, -0.08, 0), (0.62, 0.42, 0.44), "shorts")
ell("ol_torso", spine, (0, 0.85, 0), (0.72, 0.95, 0.52), "shirt")

# Head: big and round, cartoon eyes, cap with a brim
ell("ol_head", neck, (0, 0.75, 0), (0.8, 0.78, 0.78), "skin")
ell("ol_nose", neck, (0, 0.6, -0.78), (0.12, 0.11, 0.11), "skin", subdiv=2)
for sx, tag in ((1, "R"), (-1, "L")):
    ell(f"ol_eye_{tag}", neck, (sx * 0.27, 0.86, -0.64), (0.17, 0.23, 0.12), "eye_white", subdiv=2)
    ell(f"flat_pupil_{tag}", neck, (sx * 0.25, 0.84, -0.75), (0.085, 0.11, 0.05), "pupil", subdiv=2)
    ell(f"ol_ear_{tag}", neck, (sx * 0.78, 0.72, 0.02), (0.1, 0.17, 0.13), "skin", subdiv=2)
ell("ol_cap", neck, (0, 1.06, 0.03), (0.83, 0.56, 0.83), "cap")
cyl("ol_cap_brim", neck, (0, 1.1, -0.66), 0.5, 0.06, "cap", axis="y", scale=(1.0, 0.85, 1.0))

# Arms (shirt sleeve at the shoulder)
for sx, tag, sh, el, hand in ((1, "R", sh_r, el_r, hand_r), (-1, "L", sh_l, el_l, hand_l)):
    ell(f"ol_sleeve_{tag}", sh, (0, -0.1, 0), (0.29, 0.32, 0.29), "shirt")
    ell(f"ol_upperarm_{tag}", sh, (0, -0.42, 0), (0.18, 0.42, 0.18), "skin")
    ell(f"ol_forearm_{tag}", el, (0, -0.36, 0), (0.16, 0.4, 0.16), "skin")
    ell(f"ol_hand_{tag}", hand, (0, -0.02, 0), (0.19, 0.2, 0.19), "skin", subdiv=2)

# Paddle in the right hand: grip continues the forearm, face points forward when the arm hangs.
cyl("ol_paddle_grip", hand_r, (0, -0.28, 0), 0.075, 0.5, "grip", verts=12)
cyl("ol_paddle_face", hand_r, (0, -0.85, 0), 0.34, 0.07, "paddle", axis="z", scale=(1.0, 1.25, 1.0), verts=28)

# Legs
for sx, tag, hip, knee in ((1, "R", hip_r, knee_r), (-1, "L", hip_l, knee_l)):
    ell(f"ol_thigh_{tag}", hip, (0, -0.5, 0), (0.25, 0.6, 0.25), "skin")
    ell(f"ol_shin_{tag}", knee, (0, -0.42, 0), (0.2, 0.5, 0.2), "skin")
    ell(f"ol_sock_{tag}", knee, (0, -0.78, 0), (0.18, 0.15, 0.18), "sock", subdiv=2)
    ell(f"ol_shoe_{tag}", knee, (0, -0.96, -0.13), (0.25, 0.17, 0.42), "shoe")

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True)
print(f"Exported {OUT}")
