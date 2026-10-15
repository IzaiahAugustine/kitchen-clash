"""Builds the Pickle Pop! court environment and exports it as a .glb.

Run via `npm run models` (headless Blender). Units are feet, 1 Blender unit = 1 ft.
All geometry is authored in *game* coordinates (x = right, y = up, z = toward the near
baseline / camera) and converted to Blender's Z-up space with G(); the glTF exporter's
Y-up conversion turns it back into game coordinates on the Three.js side.

Object name prefixes tell the game how to shade each piece:
  flat_  toon-shaded, receives shadows, no outline (court paint, ground)
  ol_    toon-shaded with a cartoon outline, casts shadows
  net_   the see-through net mesh
"""

import math
import os
import random
import sys

import bmesh
import bpy

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(args[0] if args else "court.glb")

# Court constants (feet). Keep in sync with src/game/court.ts
HALF_W, HALF_L, KITCHEN, LINE_W = 10.0, 22.0, 7.0, 2.0 / 12.0
POST_X, NET_H_CENTER, NET_H_POST = 11.0, 34.0 / 12.0, 36.0 / 12.0
TAPE_H = 2.0 / 12.0

# Surroundings
FENCE_X, FENCE_Z, FENCE_H = 17.0, 32.0, 4.0

COLORS = {
    "grass": "#7cc95a",
    "surround": "#2f9e63",
    "court": "#2f74d0",
    "kitchen": "#5cc4ff",
    "line": "#ffffff",
    "post": "#2c2f3d",
    "post_cap": "#ffd23f",
    "tape": "#ffffff",
    "net": "#20222c",
    "fence_post": "#3a3f4b",
    "windscreen": "#1e5b3c",
    "bleacher_seat": "#e8ecf2",
    "bleacher_accent": "#ff6b6b",
    "trunk": "#8b5a2b",
    "leaf_a": "#4caf50",
    "leaf_b": "#66c25a",
    "leaf_c": "#3d9a46",
    "hill_a": "#5fb44f",
    "hill_b": "#79c766",
}


def net_h(x):
    t = min(abs(x) / POST_X, 1.0)
    return NET_H_CENTER + (NET_H_POST - NET_H_CENTER) * t * t


def G(x, y, z):
    """Game coords (y up, z toward camera) -> Blender coords (z up)."""
    return (x, -z, y)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


# ---------------------------------------------------------------- materials

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
        m.use_nodes = True  # deprecated (always on) in newer Blender
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


# ---------------------------------------------------------------- geometry helpers

def link(ob):
    scene.collection.objects.link(ob)
    return ob


def mesh_obj(name, verts, faces, material, uvs=None, recalc=False, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([G(*v) for v in verts], [], faces)
    if recalc:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.to_mesh(me)
        bm.free()
    if uvs is not None:
        layer = me.uv_layers.new(name="UVMap")
        for loop in me.loops:
            layer.data[loop.index].uv = uvs[loop.vertex_index]
    for p in me.polygons:
        p.use_smooth = smooth
    me.update()
    me.materials.append(mat(material))
    return link(bpy.data.objects.new(name, me))


def plane(name, x0, z0, x1, z1, y, material):
    """Horizontal, upward-facing rectangle."""
    return mesh_obj(name, [(x0, y, z0), (x0, y, z1), (x1, y, z1), (x1, y, z0)], [(0, 1, 2, 3)], material)


def box(name, cx, cy, cz, sx, sy, sz, material):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    verts = [(cx + dx * hx, cy + dy * hy, cz + dz * hz) for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return mesh_obj(name, verts, faces, material, recalc=True)


def prim(kind, name, loc, material, smooth=True, scale=None, **kw):
    loc = G(*loc)
    if kind == "cyl":
        bpy.ops.mesh.primitive_cylinder_add(location=loc, **kw)
    elif kind == "cone":
        bpy.ops.mesh.primitive_cone_add(location=loc, **kw)
    elif kind == "ico":
        bpy.ops.mesh.primitive_ico_sphere_add(location=loc, **kw)
    else:
        raise ValueError(kind)
    ob = bpy.context.active_object
    ob.name = name
    ob.data.name = name
    if scale:
        sx, sy, sz = scale
        ob.scale = (sx, sz, sy)
    ob.data.materials.clear()
    ob.data.materials.append(mat(material))
    for p in ob.data.polygons:
        p.use_smooth = smooth
    return ob


def join(objs, name):
    """Merge same-material objects into one mesh to keep draw calls low."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return ob


# ---------------------------------------------------------------- court surface

plane("flat_ground", -220, -220, 220, 220, -0.05, "grass")
plane("flat_surround", -FENCE_X, -FENCE_Z, FENCE_X, FENCE_Z, 0.0, "surround")
plane("flat_court", -HALF_W, -HALF_L, HALF_W, HALF_L, 0.01, "court")
plane("flat_kitchen_far", -HALF_W, -KITCHEN, HALF_W, 0, 0.02, "kitchen")
plane("flat_kitchen_near", -HALF_W, 0, HALF_W, KITCHEN, 0.02, "kitchen")

# Lines are part of the court: outer edges sit exactly on the 20x44 boundary,
# and the kitchen line's outer edge is 7 ft from the net.
W = LINE_W
lines = [
    (-HALF_W, -HALF_L, HALF_W, -HALF_L + W),        # far baseline
    (-HALF_W, HALF_L - W, HALF_W, HALF_L),          # near baseline
    (-HALF_W, -HALF_L, -HALF_W + W, HALF_L),        # left sideline
    (HALF_W - W, -HALF_L, HALF_W, HALF_L),          # right sideline
    (-HALF_W, -KITCHEN, HALF_W, -KITCHEN + W),      # far kitchen line
    (-HALF_W, KITCHEN - W, HALF_W, KITCHEN),        # near kitchen line
    (-W / 2, -HALF_L, W / 2, -KITCHEN),             # far centerline
    (-W / 2, KITCHEN, W / 2, HALF_L),               # near centerline
]
join([plane(f"line_{i}", *l, 0.03, "line") for i, l in enumerate(lines)], "flat_lines")

# ---------------------------------------------------------------- net

COLS, ROWS, NET_BOTTOM = 44, 6, 0.1
verts, uvs, faces = [], [], []
for i in range(COLS + 1):
    x = -POST_X + 2 * POST_X * i / COLS
    top = net_h(x) - TAPE_H
    for j in range(ROWS + 1):
        y = NET_BOTTOM + (top - NET_BOTTOM) * j / ROWS
        verts.append((x, y, 0.0))
        uvs.append((x + POST_X, y))  # UVs in feet; the game tiles the mesh texture
for i in range(COLS):
    for j in range(ROWS):
        a, b = i * (ROWS + 1) + j, (i + 1) * (ROWS + 1) + j
        faces.append((a, b, b + 1, a + 1))
mesh_obj("net_mesh", verts, faces, "net", uvs=uvs)

# White tape along the sagging top of the net
tv, tf = [], []
for i in range(COLS + 1):
    x = -POST_X + 2 * POST_X * i / COLS
    h = net_h(x)
    tv += [(x, h - TAPE_H, 0.0), (x, h + 0.02, 0.0)]
for i in range(COLS):
    a = i * 2
    tf.append((a, a + 2, a + 3, a + 1))
mesh_obj("flat_tape", tv, tf, "tape")

# Center strap
hc = net_h(0)
mesh_obj("flat_tape_strap", [(-0.09, 0, 0.01), (0.09, 0, 0.01), (0.09, hc, 0.01), (-0.09, hc, 0.01)],
         [(0, 1, 2, 3)], "tape")

# Posts
posts, caps = [], []
for sx in (-1, 1):
    posts.append(prim("cyl", f"post_{sx}", (sx * POST_X, 1.6, 0), "post", vertices=16, radius=0.14, depth=3.2))
    posts.append(box(f"post_base_{sx}", sx * POST_X, 0.08, 0, 0.6, 0.16, 0.6, "post"))
    caps.append(prim("ico", f"cap_{sx}", (sx * POST_X, 3.25, 0), "post_cap", subdivisions=2, radius=0.22))
join(posts, "ol_net_posts")
join(caps, "ol_net_caps")

# ---------------------------------------------------------------- fence

fence_posts = []
n = 0
for x in [-FENCE_X + i * (2 * FENCE_X) / 4 for i in range(5)]:
    for z in (-FENCE_Z, FENCE_Z):
        fence_posts.append(prim("cyl", f"fp_{n}", (x, (FENCE_H + 0.4) / 2, z), "fence_post",
                                vertices=10, radius=0.16, depth=FENCE_H + 0.4))
        n += 1
for z in [-FENCE_Z + i * (2 * FENCE_Z) / 8 for i in range(1, 8)]:
    for x in (-FENCE_X, FENCE_X):
        fence_posts.append(prim("cyl", f"fp_{n}", (x, (FENCE_H + 0.4) / 2, z), "fence_post",
                                vertices=10, radius=0.16, depth=FENCE_H + 0.4))
        n += 1
# top rails
fence_posts += [
    box("rail_l", -FENCE_X, FENCE_H + 0.3, 0, 0.22, 0.22, 2 * FENCE_Z, "fence_post"),
    box("rail_r", FENCE_X, FENCE_H + 0.3, 0, 0.22, 0.22, 2 * FENCE_Z, "fence_post"),
    box("rail_f", 0, FENCE_H + 0.3, -FENCE_Z, 2 * FENCE_X, 0.22, 0.22, "fence_post"),
    box("rail_n", 0, FENCE_H + 0.3, FENCE_Z, 2 * FENCE_X, 0.22, 0.22, "fence_post"),
]
join(fence_posts, "ol_fence_posts")
join([
    box("ws_l", -FENCE_X, FENCE_H / 2, 0, 0.12, FENCE_H, 2 * FENCE_Z, "windscreen"),
    box("ws_r", FENCE_X, FENCE_H / 2, 0, 0.12, FENCE_H, 2 * FENCE_Z, "windscreen"),
    box("ws_f", 0, FENCE_H / 2, -FENCE_Z, 2 * FENCE_X, FENCE_H, 0.12, "windscreen"),
    box("ws_n", 0, FENCE_H / 2, FENCE_Z, 2 * FENCE_X, FENCE_H, 0.12, "windscreen"),
], "ol_windscreen")

# ---------------------------------------------------------------- bleachers

seats, accents = [], []
STEP_H, STEP_D, ROWS_B = 1.3, 2.4, 4
for i in range(ROWS_B):
    h = (i + 1) * STEP_H
    # behind the far baseline, facing the court
    seats.append(box(f"bf_{i}", 0, h / 2, -(FENCE_Z + 2 + STEP_D * (i + 0.5)), 30, h, STEP_D, "bleacher_seat"))
    # along the left sideline
    seats.append(box(f"bl_{i}", -(FENCE_X + 2 + STEP_D * (i + 0.5)), h / 2, -4, STEP_D, h, 40, "bleacher_seat"))
    # colored seat-edge stripes
    accents.append(box(f"af_{i}", 0, h + 0.06, -(FENCE_Z + 2 + STEP_D * i + 0.25), 30, 0.12, 0.5, "bleacher_accent"))
    accents.append(box(f"al_{i}", -(FENCE_X + 2 + STEP_D * i + 0.25), h + 0.06, -4, 0.5, 0.12, 40, "bleacher_accent"))
join(seats, "ol_bleachers")
join(accents, "ol_bleacher_stripes")

# ---------------------------------------------------------------- trees & hills

rng = random.Random(7)


def clear_of_stuff(x, z):
    if abs(x) < FENCE_X + 3 and abs(z) < FENCE_Z + 3:
        return False  # inside / hugging the fence
    if abs(x) < 19 and -FENCE_Z - 14 < z < -FENCE_Z:
        return False  # far bleachers
    if -FENCE_X - 14 < x < -FENCE_X and -26 < z < 18:
        return False  # side bleachers
    return z < 36  # nothing behind the camera


trunks, leaves = [], {"leaf_a": [], "leaf_b": [], "leaf_c": []}
placed = 0
attempts = 0
while placed < 46 and attempts < 2000:
    attempts += 1
    x, z = rng.uniform(-70, 70), rng.uniform(-90, 36)
    if not clear_of_stuff(x, z):
        continue
    s = rng.uniform(0.8, 1.35)
    trunks.append(prim("cyl", f"trunk_{placed}", (x, 2.2 * s, z), "trunk", vertices=8,
                       radius=0.55 * s, depth=4.4 * s))
    key = rng.choice(list(leaves))
    leaves[key].append(prim("ico", f"leaf_{placed}_0", (x, 6.2 * s, z), key, subdivisions=2, radius=3.2 * s))
    leaves[key].append(prim("ico", f"leaf_{placed}_1", (x + 1.2 * s, 7.9 * s, z - 0.6 * s), key,
                            subdivisions=2, radius=2.1 * s))
    placed += 1
join(trunks, "ol_tree_trunks")
for key, objs in leaves.items():
    if objs:
        join(objs, f"ol_tree_{key}")

hills = {"hill_a": [], "hill_b": []}
for i in range(9):
    x = -140 + i * 35 + rng.uniform(-8, 8)
    z = rng.uniform(-150, -120)
    key = "hill_a" if i % 2 else "hill_b"
    r = rng.uniform(30, 45)
    hills[key].append(prim("ico", f"hill_{i}", (x, -r * 0.55, z), key, subdivisions=3, radius=r,
                           scale=(1.4, 1.0, 1.0)))
for key, objs in hills.items():
    join(objs, f"ol_{key}")

# ---------------------------------------------------------------- export

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True)
print(f"Exported {OUT}")
