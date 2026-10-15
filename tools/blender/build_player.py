"""Builds the Kitchen Clash player and exports it as a .glb.

Run via `npm run models`. Units are feet. The character is authored in game coordinates
(see build_court.py): standing at the origin, facing -z (toward the far court), right hand +x.
Stylized but human proportions: ~5.9 ft tall, shaped torso and limbs (lofted cross-sections
smoothed with subdivision), a face with eyes, brows, nose and mouth, hair, and a real paddle.

The skeleton is a hierarchy of empties named j_* (joints). Body parts are rigidly parented
to them, and the game animates the joints procedurally so swings line up exactly with
ball contact. Joints carry no rotation, so a joint's local axes match the character's:
rotating about +x swings a hanging limb forward. Keep joint offsets in sync with
src/players/body.ts.

Material names are palette slots the game recolors per player (src/players/palette.ts).
Object prefixes: ol_ = gets an outline, flat_ = no outline (small face details).
Headwear variants (cap / headband) are all included; the game shows the one a player wears.
"""

import math
import os
import sys

import bmesh
import bpy

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(args[0] if args else "player.glb")

COLORS = {
    "skin": "#e0ac69",
    "lips": "#b5654f",
    "hair": "#3b2414",
    "shirt": "#ff6b35",
    "trim": "#ffffff",
    "shorts": "#2b2d42",
    "cap": "#ffd23f",
    "headband": "#ffffff",
    "shoe": "#f5f5f5",
    "sole": "#ffffff",
    "sock": "#ffffff",
    "paddle": "#e63946",
    "paddle_edge": "#1b1530",
    "grip": "#1b1530",
    "eye_white": "#ffffff",
    "iris": "#4a2c17",
    "pupil": "#0b0b12",
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
    bsdf.inputs["Roughness"].default_value = 0.8
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


def _attach(ob, parent, offset, material, smooth=True, subsurf=0, rotation=None):
    ob.parent = parent
    ob.location = G(*offset)
    if rotation:
        ob.rotation_euler = rotation
    ob.data.materials.clear()
    ob.data.materials.append(mat(material))
    for p in ob.data.polygons:
        p.use_smooth = smooth
    if subsurf:
        mod = ob.modifiers.new("smooth", "SUBSURF")
        mod.levels = subsurf
        mod.render_levels = subsurf
    return ob


def loft(name, parent, rings, material, axis="y", segments=14, subsurf=1, offset=(0, 0, 0)):
    """Smooth tube through elliptical cross-sections, capped at both ends.

    rings: list of (t, ra, rb, ca, cb): position t along `axis`; radii and center offsets
    on the two perpendicular axes. For axis 'y' those are (x, z); for axis 'z' they're (x, y).
    """
    verts, faces = [], []

    def point(t, a, b):
        return (a, t, b) if axis == "y" else (a, b, t)

    for (t, ra, rb, ca, cb) in rings:
        for k in range(segments):
            ang = 2 * math.pi * k / segments
            verts.append(point(t, ca + ra * math.cos(ang), cb + rb * math.sin(ang)))
    n = len(rings)
    for i in range(n - 1):
        for k in range(segments):
            a = i * segments + k
            b = i * segments + (k + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    # caps: a center vertex fanned to the end rings
    for idx, ring in ((0, rings[0]), (n - 1, rings[-1])):
        t, ra, rb, ca, cb = ring
        c = len(verts)
        verts.append(point(t, ca, cb))
        base = idx * segments
        for k in range(segments):
            faces.append((base + k, base + (k + 1) % segments, c))
    me = bpy.data.meshes.new(name)
    me.from_pydata([G(*v) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return _attach(ob, parent, offset, material, subsurf=subsurf)


def ell(name, parent, center, radii, material, segs=20, rings=12, rotation=None):
    """Ellipsoid (radii in game x, y, z)."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=1.0, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = ob.data.name = name
    rx, ry, rz = radii
    ob.scale = (rx, rz, ry)
    return _attach(ob, parent, center, material, rotation=rotation)


def rounded_box(name, parent, center, size, material, bevel, rotation=None):
    """Box (size in game x, y, z) with rounded edges."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = ob.data.name = name
    sx, sy, sz = size
    ob.scale = (sx, sz, sy)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    mod = ob.modifiers.new("round", "BEVEL")
    mod.width = bevel
    mod.segments = 4
    mod.limit_method = "NONE"
    return _attach(ob, parent, center, material, smooth=True, rotation=rotation)


def cyl(name, parent, center, radius, depth, material, verts=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = ob.data.name = name
    return _attach(ob, parent, center, material)


def torus(name, parent, center, major, minor, material, scale=(1, 1, 1)):
    """Ring lying flat (around the game y axis)."""
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=28,
                                     minor_segments=8, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = ob.data.name = name
    sx, sy, sz = scale
    ob.scale = (sx, sz, sy)
    return _attach(ob, parent, center, material)


# ---------------------------------------------------------------- skeleton (keep in sync with body.ts)

root = joint("j_root", None, (0, 0, 0))
hips = joint("j_hips", root, (0, 3.05, 0))
spine = joint("j_spine", hips, (0, 0.1, 0))
neck = joint("j_neck", spine, (0, 1.62, 0))
sh_r = joint("j_shoulder_R", spine, (0.6, 1.5, 0))
el_r = joint("j_elbow_R", sh_r, (0, -0.95, 0))
hand_r = joint("j_hand_R", el_r, (0, -0.85, 0))
sh_l = joint("j_shoulder_L", spine, (-0.6, 1.5, 0))
el_l = joint("j_elbow_L", sh_l, (0, -0.95, 0))
hand_l = joint("j_hand_L", el_l, (0, -0.85, 0))
hip_r = joint("j_hip_R", hips, (0.28, -0.12, 0))
knee_r = joint("j_knee_R", hip_r, (0, -1.35, 0))
hip_l = joint("j_hip_L", hips, (-0.28, -0.12, 0))
knee_l = joint("j_knee_L", hip_l, (0, -1.35, 0))

# ---------------------------------------------------------------- torso & shorts

# (t, rx, rz, cx, cz): waist tucked into the shorts, chest, broad shoulders, collar
loft("ol_torso", spine, [
    (-0.05, 0.47, 0.31, 0, 0.0),
    (0.35, 0.46, 0.3, 0, 0.0),
    (0.8, 0.54, 0.37, 0, -0.03),
    (1.15, 0.6, 0.4, 0, -0.02),
    (1.42, 0.6, 0.34, 0, 0.01),
    (1.58, 0.24, 0.19, 0, 0.02),
], "shirt", segments=16)
torus("ol_collar", spine, (0, 1.56, 0.02), 0.19, 0.035, "trim", scale=(1.1, 1, 0.9))
loft("ol_shorts", hips, [
    (0.18, 0.49, 0.32, 0, 0),
    (-0.05, 0.51, 0.34, 0, 0),
    (-0.3, 0.52, 0.33, 0, 0.01),
], "shorts", segments=16)
loft("ol_waistband", hips, [
    (0.2, 0.495, 0.325, 0, 0),
    (0.1, 0.5, 0.33, 0, 0),
], "trim", segments=16, subsurf=0)

# ---------------------------------------------------------------- head

loft("ol_neck", neck, [(-0.12, 0.16, 0.15, 0, 0.02), (0.3, 0.15, 0.14, 0, 0.03)], "skin", segments=12)
ell("ol_head", neck, (0, 0.6, 0), (0.39, 0.47, 0.43), "skin", segs=24, rings=16)
ell("ol_nose", neck, (0, 0.56, -0.44), (0.05, 0.08, 0.06), "skin", segs=12, rings=8)
for sx, tag in ((1, "R"), (-1, "L")):
    ell(f"ol_ear_{tag}", neck, (sx * 0.39, 0.58, 0.03), (0.05, 0.11, 0.08), "skin", segs=12, rings=8)
    ell(f"flat_eye_{tag}", neck, (sx * 0.15, 0.66, -0.385), (0.085, 0.065, 0.04), "eye_white", segs=14, rings=8)
    ell(f"flat_iris_{tag}", neck, (sx * 0.15, 0.66, -0.418), (0.048, 0.05, 0.02), "iris", segs=12, rings=8)
    ell(f"flat_pupil_{tag}", neck, (sx * 0.15, 0.66, -0.433), (0.024, 0.026, 0.012), "pupil", segs=10, rings=6)
    rounded_box(f"flat_brow_{tag}", neck, (sx * 0.16, 0.765, -0.39), (0.13, 0.03, 0.04), "hair", 0.012,
                rotation=(0, sx * 0.12, 0))
ell("flat_mouth", neck, (0, 0.43, -0.405), (0.085, 0.018, 0.025), "lips", segs=12, rings=6)

# Hair: a cap of hair over the top/back of the head with sideburns
ell("ol_hair", neck, (0, 0.7, 0.05), (0.415, 0.36, 0.45), "hair", segs=24, rings=14)
for sx, tag in ((1, "R"), (-1, "L")):
    ell(f"ol_sideburn_{tag}", neck, (sx * 0.36, 0.6, -0.05), (0.06, 0.12, 0.09), "hair", segs=10, rings=6)

# Headwear variants (the game shows one per player)
ell("ol_cap", neck, (0, 0.82, 0.0), (0.43, 0.27, 0.46), "cap", segs=24, rings=14)
rounded_box("ol_cap_brim", neck, (0, 0.8, -0.5), (0.5, 0.035, 0.36), "cap", 0.015, rotation=(-0.12, 0, 0))
torus("ol_headband", neck, (0, 0.78, 0.01), 0.405, 0.045, "headband", scale=(1.0, 1, 1.08))

# ---------------------------------------------------------------- arms

for tag, sh, el, hand in (("R", sh_r, el_r, hand_r), ("L", sh_l, el_l, hand_l)):
    ell(f"ol_shoulder_{tag}", sh, (-0.04 if tag == "R" else 0.04, -0.08, 0), (0.18, 0.15, 0.19), "shirt")
    loft(f"ol_sleeve_{tag}", sh, [
        (0.0, 0.2, 0.2, 0, 0),
        (-0.42, 0.19, 0.19, 0, 0),
    ], "shirt", segments=12)
    loft(f"ol_sleevehem_{tag}", sh, [(-0.38, 0.195, 0.195, 0, 0), (-0.44, 0.195, 0.195, 0, 0)], "trim",
         segments=12, subsurf=0)
    loft(f"ol_upperarm_{tag}", sh, [
        (-0.3, 0.155, 0.155, 0, 0),
        (-0.55, 0.155, 0.145, 0, -0.01),
        (-0.95, 0.115, 0.11, 0, 0),
    ], "skin", segments=12)
    loft(f"ol_forearm_{tag}", el, [
        (0.03, 0.115, 0.11, 0, 0),
        (-0.22, 0.13, 0.12, 0, 0),
        (-0.8, 0.085, 0.075, 0, 0),
    ], "skin", segments=12)
    # Rounded joints so limbs read as one continuous arm instead of mannequin segments
    ell(f"ol_elbow_{tag}", el, (0, 0, 0), (0.115, 0.12, 0.11), "skin", segs=14, rings=10)
    ell(f"ol_wrist_{tag}", hand, (0, 0.02, 0), (0.08, 0.07, 0.075), "skin", segs=12, rings=8)
    ell(f"ol_hand_{tag}", hand, (0, -0.08, 0), (0.09, 0.13, 0.1), "skin", segs=14, rings=10)
    ell(f"ol_thumb_{tag}", hand, (-0.06 if tag == "R" else 0.06, -0.04, -0.06), (0.035, 0.07, 0.035), "skin",
        segs=10, rings=6)

# Paddle in the right hand: handle continues the forearm, face points forward when the arm hangs.
cyl("ol_paddle_grip", hand_r, (0, -0.2, 0), 0.055, 0.42, "grip", verts=12)
rounded_box("ol_paddle_edge", hand_r, (0, -0.83, 0), (0.66, 0.88, 0.04), "paddle_edge", 0.2)
rounded_box("ol_paddle_face", hand_r, (0, -0.83, 0), (0.62, 0.84, 0.055), "paddle", 0.18)

# ---------------------------------------------------------------- legs

for tag, hip, knee in (("R", hip_r, knee_r), ("L", hip_l, knee_l)):
    loft(f"ol_shortleg_{tag}", hip, [
        (0.05, 0.27, 0.28, 0, 0),
        (-0.72, 0.25, 0.26, 0, 0),
    ], "shorts", segments=12)
    ell(f"ol_knee_{tag}", knee, (0, 0, -0.01), (0.15, 0.16, 0.155), "skin", segs=14, rings=10)
    loft(f"ol_thigh_{tag}", hip, [
        (-0.4, 0.235, 0.245, 0, 0),
        (-0.9, 0.2, 0.21, 0, -0.01),
        (-1.35, 0.15, 0.155, 0, 0),
    ], "skin", segments=12)
    loft(f"ol_calf_{tag}", knee, [
        (0.03, 0.145, 0.15, 0, 0),
        (-0.35, 0.16, 0.175, 0, 0.03),
        (-0.85, 0.11, 0.115, 0, 0.01),
        (-1.1, 0.09, 0.095, 0, 0),
    ], "skin", segments=12)
    loft(f"ol_sock_{tag}", knee, [(-0.98, 0.105, 0.11, 0, 0), (-1.32, 0.1, 0.105, 0, 0)], "sock", segments=12)
    # Shoe: lofted from heel to toe along z; (z, half-width, half-height, x, y-center)
    loft(f"ol_shoe_{tag}", knee, [
        (0.22, 0.12, 0.12, 0, -1.43),
        (0.1, 0.15, 0.16, 0, -1.42),
        (-0.2, 0.165, 0.12, 0, -1.46),
        (-0.5, 0.14, 0.08, 0, -1.5),
        (-0.66, 0.08, 0.045, 0, -1.52),
    ], "shoe", axis="z", segments=14)
    loft(f"ol_sole_{tag}", knee, [
        (0.24, 0.13, 0.035, 0, -1.545),
        (-0.2, 0.175, 0.035, 0, -1.545),
        (-0.66, 0.1, 0.03, 0, -1.55),
    ], "sole", axis="z", segments=14)

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True)
print(f"Exported {OUT}")
