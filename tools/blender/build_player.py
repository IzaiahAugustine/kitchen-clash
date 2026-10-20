"""Builds the Dinkzilla player and exports it as a .glb.

Run via `npm run models`. Units are feet. The character is authored in game coordinates
(see build_court.py): standing at the origin, facing -z (toward the far court), right hand +x.
Athletic, human proportions: ~5.9 ft tall, a shaped torso, one-piece arms and legs (lofted
cross-sections smoothed with subdivision) that the game skins so elbows and knees bend smoothly,
a sculpted head with eyes, lids, brows, nose and mouth, hair, polo shirt, shoes and a real paddle.

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
    "hair_tail": "#3b2414",
    "crown": "#ffc83d",
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
ankle_r = joint("j_ankle_R", knee_r, (0, -1.3, 0))
hip_l = joint("j_hip_L", hips, (-0.28, -0.12, 0))
knee_l = joint("j_knee_L", hip_l, (0, -1.35, 0))
ankle_l = joint("j_ankle_L", knee_l, (0, -1.3, 0))

# ---------------------------------------------------------------- torso & shorts

# (t, rx, rz, cx, cz); -z is the front. An athletic V: narrow waist, full chest, shoulders that
# slope into the neck. The shirt is worn untucked, its hem flaring over the shorts.
loft("ol_torso", spine, [
    (-0.22, 0.53, 0.35, 0, 0.0),
    (-0.12, 0.52, 0.345, 0, 0.0),
    (0.15, 0.48, 0.315, 0, 0.0),
    (0.45, 0.46, 0.3, 0, 0.0),
    (0.82, 0.53, 0.345, 0, -0.035),
    (1.12, 0.59, 0.37, 0, -0.035),
    (1.36, 0.61, 0.32, 0, 0.0),
    (1.5, 0.46, 0.25, 0, 0.02),
    (1.6, 0.2, 0.17, 0, 0.02),
], "shirt", segments=20)
# Polo collar
torus("ol_collar", spine, (0, 1.57, 0.015), 0.2, 0.045, "trim", scale=(1.1, 1.25, 0.95))
loft("ol_shorts", hips, [
    (0.2, 0.47, 0.31, 0, 0),
    (0.0, 0.5, 0.33, 0, 0),
    (-0.3, 0.53, 0.345, 0, 0.02),
], "shorts", segments=20)
loft("ol_waistband", hips, [
    (0.21, 0.475, 0.315, 0, 0),
    (0.1, 0.49, 0.325, 0, 0),
], "trim", segments=20, subsurf=0)

# ---------------------------------------------------------------- head

loft("ol_neck", neck, [(-0.12, 0.19, 0.18, 0, 0.02), (0.1, 0.18, 0.17, 0, 0.03), (0.3, 0.17, 0.16, 0, 0.04)], "skin", segments=14)
# Sculpted head: chin, jaw, cheekbones, brow and cranium (taller than wide, face toward -z).
loft("ol_head", neck, [
    (0.12, 0.1, 0.09, 0, -0.12),
    (0.17, 0.2, 0.2, 0, -0.07),
    (0.28, 0.28, 0.3, 0, -0.02),
    (0.46, 0.33, 0.37, 0, 0.0),
    (0.6, 0.35, 0.395, 0, 0.01),
    (0.76, 0.35, 0.395, 0, 0.02),
    (0.9, 0.3, 0.34, 0, 0.03),
    (0.99, 0.18, 0.2, 0, 0.03),
    (1.02, 0.03, 0.03, 0, 0.03),
], "skin", segments=20)
ell("ol_nose", neck, (0, 0.55, -0.405), (0.045, 0.085, 0.06), "skin", segs=12, rings=8)
ell("ol_nosetip", neck, (0, 0.5, -0.43), (0.05, 0.04, 0.04), "skin", segs=12, rings=8)
for sx, tag in ((1, "R"), (-1, "L")):
    ell(f"ol_ear_{tag}", neck, (sx * 0.35, 0.57, 0.04), (0.045, 0.105, 0.075), "skin", segs=12, rings=8)
    ell(f"flat_eye_{tag}", neck, (sx * 0.135, 0.635, -0.35), (0.066, 0.046, 0.034), "eye_white", segs=14, rings=8)
    ell(f"flat_iris_{tag}", neck, (sx * 0.135, 0.632, -0.378), (0.037, 0.039, 0.016), "iris", segs=12, rings=8)
    ell(f"flat_pupil_{tag}", neck, (sx * 0.135, 0.632, -0.39), (0.018, 0.02, 0.01), "pupil", segs=10, rings=6)
    # Upper eyelid: takes the wide-eyed cartoon stare away
    ell(f"ol_lid_{tag}", neck, (sx * 0.135, 0.668, -0.345), (0.075, 0.032, 0.045), "skin", segs=14, rings=8)
    rounded_box(f"flat_brow_{tag}", neck, (sx * 0.14, 0.72, -0.36), (0.12, 0.028, 0.035), "hair", 0.01,
                rotation=(0, sx * 0.14, sx * -0.08))
ell("flat_mouth", neck, (0, 0.38, -0.35), (0.07, 0.014, 0.022), "lips", segs=12, rings=6)

# Hair styles (the game shows the one a player picked): short hair over the top/back with
# sideburns and a fringe; a ponytail adds a tail; "shaved" hides both.
ell("ol_hair", neck, (0, 0.72, 0.05), (0.375, 0.33, 0.42), "hair", segs=24, rings=14)
ell("ol_fringe", neck, (0, 0.84, -0.22), (0.28, 0.08, 0.14), "hair", segs=16, rings=8, rotation=(0.35, 0, 0))
for sx, tag in ((1, "R"), (-1, "L")):
    ell(f"ol_sideburn_{tag}", neck, (sx * 0.325, 0.58, -0.04), (0.05, 0.11, 0.085), "hair", segs=10, rings=6)
ell("ol_ponytail", neck, (0, 0.52, 0.47), (0.11, 0.3, 0.12), "hair_tail", rotation=(-0.35, 0, 0))
ell("ol_hairtie", neck, (0, 0.74, 0.44), (0.07, 0.05, 0.06), "hair_tail", segs=10, rings=6)

# Headwear variants (the game shows one per player)
ell("ol_cap", neck, (0, 0.81, 0.02), (0.395, 0.25, 0.425), "cap", segs=24, rings=14)
rounded_box("ol_cap_brim", neck, (0, 0.79, -0.46), (0.46, 0.035, 0.34), "cap", 0.015, rotation=(-0.12, 0, 0))
torus("ol_headband", neck, (0, 0.76, 0.02), 0.365, 0.042, "headband", scale=(1.0, 1, 1.1))
# Tournament champion's crown
cyl("ol_crown", neck, (0, 0.95, 0.02), 0.27, 0.16, "crown", verts=16)
for i in range(6):
    a = i / 6 * 6.2832
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.07, radius2=0.0, depth=0.16, location=(0, 0, 0))
    ob = bpy.context.active_object
    ob.name = ob.data.name = f"ol_crown_point_{i}"
    _attach(ob, neck, (0.24 * math.cos(a), 1.1, 0.02 + 0.24 * math.sin(a)), "crown")

# ---------------------------------------------------------------- arms

# Each arm is ONE smooth mesh from shoulder to wrist (shoulder > biceps > elbow > forearm >
# wrist). It's parented to the shoulder; the game skins it to the shoulder, elbow and hand
# joints (src/players/playerView.ts) so it bends at the elbow without a seam.
for tag, sh, hand in (("R", sh_r, hand_r), ("L", sh_l, hand_l)):
    out = 1 if tag == "R" else -1
    ell(f"ol_shoulder_{tag}", sh, (-0.06 * out, -0.1, 0), (0.185, 0.15, 0.19), "shirt")
    loft(f"ol_sleeve_{tag}", sh, [
        (0.02, 0.215, 0.215, 0, 0),
        (-0.42, 0.205, 0.2, 0, 0),
    ], "shirt", segments=14)
    loft(f"ol_sleevehem_{tag}", sh, [(-0.38, 0.208, 0.203, 0, 0), (-0.45, 0.208, 0.203, 0, 0)], "trim",
         segments=14, subsurf=0)
    loft(f"ol_arm_{tag}", sh, [
        (0.05, 0.14, 0.14, 0, 0),
        (-0.15, 0.175, 0.17, 0, 0),
        (-0.4, 0.18, 0.17, 0, 0),
        (-0.58, 0.17, 0.168, 0, -0.012),
        (-0.8, 0.14, 0.135, 0, 0),
        (-0.95, 0.125, 0.125, 0, 0.01),
        (-1.08, 0.135, 0.128, 0, 0.005),
        (-1.24, 0.14, 0.13, 0, 0),
        (-1.52, 0.105, 0.095, 0, 0),
        (-1.74, 0.083, 0.068, 0, 0),
        (-1.84, 0.088, 0.072, 0, 0),
    ], "skin", segments=14)
    # Hand: palm, a fist of fingers (wrapped round the paddle grip on the right) and a thumb.
    ell(f"ol_palm_{tag}", hand, (0, -0.08, 0), (0.075, 0.12, 0.1), "skin", segs=14, rings=10)
    rounded_box(f"ol_fist_{tag}", hand, (0.015 * out, -0.2, -0.012), (0.13, 0.16, 0.135), "skin", 0.05)
    ell(f"ol_thumb_{tag}", hand, (-0.045 * out, -0.13, -0.075), (0.035, 0.08, 0.035), "skin", segs=10, rings=6,
        rotation=(0.3, 0, 0))

# Paddle in the right hand: handle continues the forearm, face points forward when the arm hangs.
cyl("ol_paddle_grip", hand_r, (0, -0.2, 0), 0.055, 0.42, "grip", verts=12)
rounded_box("ol_paddle_edge", hand_r, (0, -0.83, 0), (0.66, 0.88, 0.04), "paddle_edge", 0.2)
rounded_box("ol_paddle_face", hand_r, (0, -0.83, 0), (0.62, 0.84, 0.055), "paddle", 0.18)

# ---------------------------------------------------------------- legs

# Like the arms, each leg is one smooth mesh from hip to ankle (thigh > knee > calf > ankle),
# skinned in the game to the hip, knee and ankle joints. Feet hang off the ankle joint, which
# the game keeps level so feet stay flat on the court.
for tag, hip, ankle in (("R", hip_r, ankle_r), ("L", hip_l, ankle_l)):
    out = 1 if tag == "R" else -1
    loft(f"ol_shortleg_{tag}", hip, [
        (0.05, 0.29, 0.3, 0, 0),
        (-0.66, 0.275, 0.285, 0.01 * out, 0),
        (-0.74, 0.285, 0.295, 0.01 * out, 0),
    ], "shorts", segments=14)
    loft(f"ol_leg_{tag}", hip, [
        (0.1, 0.22, 0.23, 0, 0),
        (-0.25, 0.25, 0.26, 0, 0),
        (-0.62, 0.235, 0.245, 0.01 * out, -0.015),
        (-0.95, 0.2, 0.21, 0, -0.01),
        (-1.2, 0.165, 0.17, 0, -0.005),
        (-1.35, 0.155, 0.16, 0, -0.012),
        (-1.5, 0.152, 0.162, 0, 0.015),
        (-1.75, 0.16, 0.18, -0.005 * out, 0.045),
        (-2.05, 0.128, 0.135, 0, 0.02),
        (-2.35, 0.098, 0.103, 0, 0.0),
        (-2.6, 0.088, 0.093, 0, 0.0),
        (-2.72, 0.09, 0.096, 0, 0.0),
    ], "skin", segments=14)
    loft(f"ol_sock_{tag}", ankle, [(0.36, 0.1, 0.106, 0, 0), (0.0, 0.098, 0.104, 0, 0)], "sock", segments=14)
    # Shoe: lofted from heel to toe along z; (z, half-width, half-height, x, y-center)
    loft(f"ol_shoe_{tag}", ankle, [
        (0.25, 0.105, 0.1, 0, -0.13),
        (0.16, 0.14, 0.15, 0, -0.1),
        (-0.08, 0.158, 0.135, 0, -0.13),
        (-0.34, 0.155, 0.1, 0, -0.165),
        (-0.55, 0.12, 0.068, 0, -0.195),
        (-0.68, 0.055, 0.038, 0, -0.21),
    ], "shoe", axis="z", segments=16)
    loft(f"ol_sole_{tag}", ankle, [
        (0.27, 0.118, 0.035, 0, -0.245),
        (-0.2, 0.17, 0.038, 0, -0.247),
        (-0.6, 0.12, 0.032, 0, -0.24),
        (-0.71, 0.055, 0.025, 0, -0.225),
    ], "sole", axis="z", segments=16)
    # A swoosh-style stripe in the shirt color on both sides of each shoe
    for side in (1, -1):
        ell(f"ol_shoestripe_{tag}_{side}", ankle, (side * 0.15, -0.15, -0.16), (0.014, 0.04, 0.2), "shirt",
            segs=12, rings=6, rotation=(0.25, 0, 0))

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True)
print(f"Exported {OUT}")
