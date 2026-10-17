import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { addOutline, surfaceMaterial } from './materials';
import { chainLink, courtSpeckle, grass, planarUVs, wallUVs, windscreen } from './textures';

/** Surface feel per court object (matched by name prefix). */
const SURFACES: [string, () => THREE.MeshStandardMaterialParameters][] = [
  ['flat_ground', () => {
    const map = grass();
    return { map, bumpMap: map, bumpScale: 1.2, roughness: 1 };
  }],
  // Acrylic hard court: sand-gritty paint with a faint sheen.
  ['flat_court', () => speckled(0.72)],
  ['flat_kitchen', () => speckled(0.72)],
  ['flat_surround', () => speckled(0.8)],
  ['flat_lines', () => ({ roughness: 0.7 })],
  ['ol_windscreen', () => ({ map: windscreen(), roughness: 0.95 })],
  ['ol_net_posts', () => ({ roughness: 0.35, metalness: 0.6 })],
  ['ol_net_caps', () => ({ roughness: 0.4 })],
  ['ol_fence_posts', () => ({ roughness: 0.4, metalness: 0.7 })],
  ['ol_bleachers', () => ({ roughness: 0.35, metalness: 0.75 })],
  ['ol_tree_trunks', () => ({ roughness: 1 })],
  ['ol_tree', () => ({ roughness: 0.9 })],
  ['ol_hill', () => {
    const map = grass();
    return { map, bumpMap: map, bumpScale: 1.2, roughness: 1 };
  }],
];

function speckled(roughness: number): THREE.MeshStandardMaterialParameters {
  const map = courtSpeckle();
  return { map, bumpMap: map, bumpScale: 0.6, roughness };
}

/** How many feet one texture repeat covers on the flat surfaces. */
const TILE_FEET: Record<string, number> = { ol_hill: 20, flat_ground: 20, flat_court: 6, flat_kitchen: 6, flat_surround: 6 };

/**
 * Loads the Blender-built court (public/models/court.glb) and dresses it: textured court and
 * grass, printed windscreens, metal posts and bleachers (see tools/blender/build_court.py).
 */
export async function loadCourt(scene: THREE.Scene, maxAnisotropy = 8): Promise<THREE.Object3D> {
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/court.glb`);
  const root = gltf.scene;

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });

  for (const mesh of meshes) {
    const name = mesh.name || mesh.parent?.name || '';
    const src = mesh.material as THREE.MeshStandardMaterial;
    const color = src.color ? src.color.clone() : new THREE.Color(0xffffff);
    src.dispose();

    if (name.startsWith('net_')) {
      mesh.material = netMaterial(color);
      continue;
    }
    const prefix = Object.keys(TILE_FEET).find((p) => name.startsWith(p));
    if (prefix) planarUVs(mesh.geometry, TILE_FEET[prefix]);
    if (name.startsWith('ol_windscreen')) wallUVs(mesh.geometry, 17, 4);

    const params = SURFACES.find(([p]) => name.startsWith(p))?.[1]() ?? {};
    // The court is seen at a low angle: full anisotropic filtering keeps its texture crisp.
    if (params.map) params.map.anisotropy = maxAnisotropy;
    // Printed textures carry their own color.
    if (name.startsWith('ol_windscreen')) color.set(0xffffff);
    // Hills: a deeper, less lime green, like the lawn.
    if (name.startsWith('ol_hill')) color.multiplyScalar(0.72);
    mesh.material = surfaceMaterial(color, {
      ...params,
      side: name.includes('tape') ? THREE.DoubleSide : THREE.FrontSide,
    });
    mesh.receiveShadow = true;
    if (name.startsWith('ol_tree_leaf')) foliage(mesh);
    if (name.startsWith('ol_')) {
      mesh.castShadow = !name.includes('hill');
      addOutline(mesh, name.includes('hill') ? 0.0006 : 0.0011);
    }
  }

  root.add(fenceAbove());
  scene.add(root);
  return root;
}

/**
 * Turns smooth leaf balls into lumpy, leafy crowns: every vertex is pushed in or out by a
 * smooth 3D noise, and shaded a little lighter on top and darker underneath and in the dips.
 */
function foliage(mesh: THREE.Mesh): void {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const noise = (x: number, y: number, z: number) =>
    Math.sin(x * 1.7 + Math.sin(z * 1.3)) * Math.cos(z * 1.9 + Math.sin(y * 1.1)) * Math.sin(y * 2.3 + x * 0.7);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = noise(x, y, z) * 0.6 + noise(x * 2.7, y * 2.7, z * 2.7) * 0.25;
    pos.setXYZ(i, x + nrm.getX(i) * n, y + nrm.getY(i) * n, z + nrm.getZ(i) * n);
    const shade = 0.72 + nrm.getY(i) * 0.18 + n * 0.25;
    colors.set([shade * 0.92, shade, shade * 0.85], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = mesh.material as THREE.MeshStandardMaterial;
  mat.vertexColors = true;
  mat.color.multiplyScalar(0.78);
  mat.roughness = 0.95;
  mat.flatShading = true;
}

// Fence line from tools/blender/build_court.py: the windscreen is 4 ft tall.
const FENCE_X = 17;
const FENCE_Z = 32;
const SCREEN_H = 4;
const FENCE_TOP = 10;

/**
 * Chain-link fence above the windscreens all the way round, with posts and a top rail. The
 * end panel behind the camera is hidden each frame (see hideFenceBehind) so it never blocks play.
 */
function fenceAbove(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fence_chainlink';
  const h = FENCE_TOP - SCREEN_H;
  const tex = chainLink();
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6 });
  const panel = (len: number, x: number, z: number, rotY: number, name = '') => {
    const t = tex.clone();
    t.repeat.set(len * 1.2, h * 1.2);
    t.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), mat.clone());
    (m.material as THREE.MeshStandardMaterial).map = t;
    m.position.set(x, SCREEN_H + h / 2, z);
    m.rotation.y = rotY;
    m.castShadow = true;
    m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: t, alphaTest: 0.35 });
    m.name = name;
    g.add(m);
    return m;
  };
  // The end panels are named so the game can drop whichever one the camera is behind.
  panel(2 * FENCE_X, 0, -FENCE_Z, 0, 'fence_end_far');
  panel(2 * FENCE_X, 0, FENCE_Z, 0, 'fence_end_near');
  panel(2 * FENCE_Z, -FENCE_X, 0, Math.PI / 2);
  panel(2 * FENCE_Z, FENCE_X, 0, Math.PI / 2);

  const metal = surfaceMaterial('#3a3f4b', { roughness: 0.4, metalness: 0.7 });
  const post = new THREE.CylinderGeometry(0.13, 0.13, FENCE_TOP, 8).translate(0, FENCE_TOP / 2, 0);
  const add = (x: number, z: number) => {
    const p = new THREE.Mesh(post, metal);
    p.position.set(x, 0, z);
    p.castShadow = true;
    g.add(p);
    return p;
  };
  for (let i = 0; i <= 4; i++) add(-FENCE_X + (i * 2 * FENCE_X) / 4, -FENCE_Z);
  for (let i = 1; i < 4; i++) add(-FENCE_X + (i * 2 * FENCE_X) / 4, FENCE_Z).name = 'fence_end_near_post';
  for (let i = 1; i <= 8; i++) for (const x of [-FENCE_X, FENCE_X]) add(x, -FENCE_Z + (i * 2 * FENCE_Z) / 8);
  const rail = (len: number, x: number, z: number, rotY: number) => {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, len, 6).rotateZ(Math.PI / 2), metal);
    r.position.set(x, FENCE_TOP, z);
    r.rotation.y = rotY;
    g.add(r);
    return r;
  };
  rail(2 * FENCE_X, 0, -FENCE_Z, 0);
  rail(2 * FENCE_X, 0, FENCE_Z, 0).name = 'fence_end_near_rail';
  rail(2 * FENCE_Z, -FENCE_X, 0, Math.PI / 2);
  rail(2 * FENCE_Z, FENCE_X, 0, Math.PI / 2);
  return g;
}

/** The net: a tiled mesh texture with see-through holes. */
function netMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.strokeStyle = `#${color.getHexString(THREE.SRGBColorSpace)}`;
  g.lineWidth = 8;
  g.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.6, 2.6); // UVs are in feet → ~4.6" cells
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 });
}

/**
 * Hides the fence along whichever end the camera is behind or close to (it would fill the
 * screen), and shows it otherwise (title fly-around, the other end).
 */
export function hideFenceBehind(court: THREE.Object3D, camera: THREE.Camera): void {
  let ends = court.userData.fenceEnds as THREE.Object3D[] | undefined;
  if (!ends) {
    ends = [];
    court.traverse((o) => o.name.startsWith('fence_end') && ends!.push(o));
    court.userData.fenceEnds = ends;
  }
  const z = camera.position.z;
  for (const o of ends) o.visible = o.name.startsWith('fence_end_near') ? z < FENCE_Z - 4 : z > -FENCE_Z + 4;
}
