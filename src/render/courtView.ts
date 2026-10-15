import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { addOutline, surfaceMaterial } from './materials';
import { courtSpeckle, grass, planarUVs, wallUVs, windscreen } from './textures';

/** Surface feel per court object (matched by name prefix). */
const SURFACES: [string, () => THREE.MeshStandardMaterialParameters][] = [
  ['flat_ground', () => ({ map: grass(), roughness: 1 })],
  ['flat_court', () => ({ map: courtSpeckle(), roughness: 0.85 })],
  ['flat_kitchen', () => ({ map: courtSpeckle(), roughness: 0.85 })],
  ['flat_surround', () => ({ map: courtSpeckle(), roughness: 0.9 })],
  ['flat_lines', () => ({ roughness: 0.7 })],
  ['ol_windscreen', () => ({ map: windscreen(), roughness: 0.95 })],
  ['ol_net_posts', () => ({ roughness: 0.35, metalness: 0.6 })],
  ['ol_net_caps', () => ({ roughness: 0.4 })],
  ['ol_fence_posts', () => ({ roughness: 0.4, metalness: 0.7 })],
  ['ol_bleachers', () => ({ roughness: 0.35, metalness: 0.75 })],
  ['ol_tree_trunks', () => ({ roughness: 1 })],
  ['ol_tree', () => ({ roughness: 0.9 })],
  ['ol_hill', () => ({ roughness: 1 })],
];

/** How many feet one texture repeat covers on the flat surfaces. */
const TILE_FEET: Record<string, number> = { flat_ground: 14, flat_court: 6, flat_kitchen: 6, flat_surround: 6 };

/**
 * Loads the Blender-built court (public/models/court.glb) and dresses it: textured court and
 * grass, printed windscreens, metal posts and bleachers (see tools/blender/build_court.py).
 */
export async function loadCourt(scene: THREE.Scene): Promise<THREE.Object3D> {
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
    // Printed textures carry their own color.
    if (name.startsWith('ol_windscreen')) color.set(0xffffff);
    mesh.material = surfaceMaterial(color, {
      ...params,
      side: name.includes('tape') ? THREE.DoubleSide : THREE.FrontSide,
    });
    mesh.receiveShadow = true;
    if (name.startsWith('ol_')) {
      mesh.castShadow = !name.includes('hill');
      addOutline(mesh, name.includes('hill') ? 0.0006 : 0.0011);
    }
  }

  scene.add(root);
  return root;
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
