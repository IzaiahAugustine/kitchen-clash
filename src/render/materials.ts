import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Stylized look: clean, mostly matte physically-based surfaces lit by the sun and sky,
 * with thin ink outlines to keep shapes crisp from the high camera.
 */

export const OUTLINE_COLOR = 0x1b1530;

export function surfaceMaterial(
  color: THREE.ColorRepresentation,
  params: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...params });
}

const outlineMaterials = new Map<number, THREE.MeshBasicMaterial>();

/**
 * Back-face hull pushed out along the normal. The push scales with view depth so the line
 * stays roughly the same pixel width near and far. Works for skinned meshes too.
 */
export function outlineMaterial(thickness = 0.0015): THREE.MeshBasicMaterial {
  const cached = outlineMaterials.get(thickness);
  if (cached) return cached;
  const m = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineThickness = { value: thickness };
    shader.vertexShader =
      'uniform float outlineThickness;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
        #ifdef USE_SKINNING
          vec3 outlineNormal = objectNormal;
        #else
          vec3 outlineNormal = normal;
        #endif
        mvPosition.xyz += normalize( normalMatrix * outlineNormal ) * outlineThickness * -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  m.customProgramCacheKey = () => `outline-${thickness}`;
  outlineMaterials.set(thickness, m);
  return m;
}

/** Adds an outline hull to a mesh. Normals are re-smoothed so hard edges don't crack the line. */
export function addOutline(mesh: THREE.Mesh, thickness?: number): THREE.Mesh {
  const geo = mesh.geometry.clone();
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'skinIndex' && name !== 'skinWeight') geo.deleteAttribute(name);
  }
  geo.morphAttributes = {};
  const smooth = mergeVertices(geo, 1e-3);
  smooth.computeVertexNormals();

  let outline: THREE.Mesh;
  const skinned = mesh as THREE.SkinnedMesh;
  if (skinned.isSkinnedMesh) {
    const o = new THREE.SkinnedMesh(smooth, outlineMaterial(thickness));
    o.bindMode = skinned.bindMode;
    o.bind(skinned.skeleton, skinned.bindMatrix);
    o.position.copy(skinned.position);
    o.quaternion.copy(skinned.quaternion);
    o.scale.copy(skinned.scale);
    skinned.parent?.add(o);
    outline = o;
  } else {
    outline = new THREE.Mesh(smooth, outlineMaterial(thickness));
    mesh.add(outline);
  }
  outline.name = `${mesh.name}_outline`;
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.raycast = () => {};
  return outline;
}
