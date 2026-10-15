import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { addOutline, toonMaterial } from './toon';

/**
 * Loads the Blender-built court (public/models/court.glb) and swaps its materials for
 * cartoon ones based on the object name prefix (see tools/blender/build_court.py).
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
    mesh.material = toonMaterial(color, { side: name.includes('tape') ? THREE.DoubleSide : THREE.FrontSide });
    mesh.receiveShadow = true;
    if (name.startsWith('ol_')) {
      mesh.castShadow = true;
      addOutline(mesh, name.includes('hill') ? 0.0012 : undefined);
    }
  }

  scene.add(root);
  return root;
}

/** Cartoon net: a tiled grid texture with see-through holes. */
function netMaterial(color: THREE.Color): THREE.MeshBasicMaterial {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.strokeStyle = `#${color.getHexString(THREE.SRGBColorSpace)}`;
  g.lineWidth = 10;
  g.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.6, 2.6); // UVs are in feet → ~4.6" cells
  tex.anisotropy = 4;
  return new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, transparent: false });
}
