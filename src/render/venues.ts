import * as THREE from 'three';
import { addOutline, surfaceMaterial } from './materials';
import { courtSpeckle } from './textures';

export type VenueId = 'park' | 'beach' | 'gym' | 'night';

/** A place to play: colors, sky and light, plus a few props. The court itself never changes size. */
export interface Venue {
  id: VenueId;
  name: string;
  sky: [string, string, string];
  fog: [number, number, number];
  hemi: [number, number, number];
  sun: { color: number; intensity: number; pos: [number, number, number] };
  exposure: number;
  /** Image-based light strength (lower = darker shadows, moodier). */
  env: number;
  colors: { court: string; kitchen: string; surround: string; ground: string; windscreen: string };
  /** Hide the park's trees and hills (indoor, beach). */
  hideNature: boolean;
}

export const VENUES: Record<VenueId, Venue> = {
  park: {
    id: 'park',
    name: 'City Park',
    sky: ['#4fb8ff', '#9edfff', '#dff6ff'],
    fog: [0xcdeeff, 150, 340],
    hemi: [0xdcefff, 0x5f8f4a, 0.9],
    sun: { color: 0xfff1dc, intensity: 2.6, pos: [-30, 70, 30] },
    exposure: 1.05,
    env: 0.45,
    colors: { court: '#2f74d0', kitchen: '#5cc4ff', surround: '#2f9e63', ground: '#7cc95a', windscreen: '#ffffff' },
    hideNature: false,
  },
  beach: {
    id: 'beach',
    name: 'Sunset Beach',
    sky: ['#ff8a5c', '#ffc38b', '#ffe9c9'],
    fog: [0xffd9b0, 120, 360],
    hemi: [0xffe2c4, 0xc9a46b, 1.0],
    sun: { color: 0xffc58f, intensity: 2.4, pos: [-70, 30, -50] },
    exposure: 1.05,
    env: 0.45,
    colors: { court: '#1f8a9e', kitchen: '#f2a65a', surround: '#2bb3a3', ground: '#ecd7a2', windscreen: '#ffe9c9' },
    hideNature: true,
  },
  gym: {
    id: 'gym',
    name: 'Rec Center Gym',
    sky: ['#cfc7bb', '#cfc7bb', '#cfc7bb'],
    fog: [0xd8d0c4, 200, 400],
    hemi: [0xfff6e8, 0x9a7a55, 1.2],
    sun: { color: 0xffffff, intensity: 1.9, pos: [0, 80, 8] },
    exposure: 1.0,
    env: 0.5,
    colors: { court: '#3a6fb0', kitchen: '#e9c46a', surround: '#c98f55', ground: '#b88250', windscreen: '#e8e1d6' },
    hideNature: true,
  },
  night: {
    id: 'night',
    name: 'Night Stadium',
    sky: ['#070a1f', '#121a45', '#26336b'],
    fog: [0x141a3e, 120, 300],
    hemi: [0x5a6cc8, 0x10182c, 0.3],
    sun: { color: 0xf3f6ff, intensity: 2.6, pos: [10, 80, 20] },
    exposure: 0.95,
    env: 0.12,
    colors: { court: '#2f74d0', kitchen: '#5cc4ff', surround: '#1f6f5a', ground: '#1e3a24', windscreen: '#ffffff' },
    hideNature: true,
  },
};

export const VENUE_ORDER: VenueId[] = ['park', 'beach', 'gym', 'night'];

/**
 * Restyles the loaded court for a venue: recolors the surfaces, swaps the sky and lighting,
 * and adds that venue's props (palms and sea, gym walls, stadium lights).
 */
export class VenueDresser {
  private props: THREE.Group | null = null;
  private meshes = new Map<string, THREE.Mesh[]>();

  constructor(
    private scene: THREE.Scene,
    court: THREE.Object3D,
    private hemi: THREE.HemisphereLight,
    private sun: THREE.DirectionalLight,
    private renderer: THREE.WebGLRenderer,
  ) {
    court.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.name.endsWith('_outline')) return;
      const key = ['flat_court', 'flat_kitchen', 'flat_surround', 'flat_ground', 'ol_windscreen', 'ol_tree', 'ol_hill'].find((k) =>
        m.name.startsWith(k),
      );
      if (key) this.meshes.set(key, [...(this.meshes.get(key) ?? []), m]);
    });
  }

  apply(v: Venue): void {
    const color = (key: string, c: string) => {
      for (const m of this.meshes.get(key) ?? []) (m.material as THREE.MeshStandardMaterial).color.set(c);
    };
    color('flat_court', v.colors.court);
    color('flat_kitchen', v.colors.kitchen);
    color('flat_surround', v.colors.surround);
    color('flat_ground', v.colors.ground);
    color('ol_windscreen', v.colors.windscreen);
    for (const key of ['ol_tree', 'ol_hill']) for (const m of this.meshes.get(key) ?? []) m.visible = !v.hideNature;
    // Sand and a gym floor read better without the grass blades.
    for (const m of this.meshes.get('flat_ground') ?? []) {
      const mat = m.material as THREE.MeshStandardMaterial;
      if (v.id === 'beach' || v.id === 'gym') {
        if (!mat.userData.speckle) mat.userData.speckle = courtSpeckle();
        if (!mat.userData.grass) mat.userData.grass = mat.map;
        mat.map = mat.userData.speckle as THREE.Texture;
      } else if (mat.userData.grass) {
        mat.map = mat.userData.grass as THREE.Texture;
      }
      mat.needsUpdate = true;
    }

    this.scene.background = skyTexture(v.sky);
    this.scene.fog = new THREE.Fog(v.fog[0], v.fog[1], v.fog[2]);
    this.hemi.color.set(v.hemi[0]);
    this.hemi.groundColor.set(v.hemi[1]);
    this.hemi.intensity = v.hemi[2];
    this.sun.color.set(v.sun.color);
    this.sun.intensity = v.sun.intensity;
    this.sun.position.set(...v.sun.pos);
    this.renderer.toneMappingExposure = v.exposure;
    this.scene.environmentIntensity = v.env;

    if (this.props) {
      this.scene.remove(this.props);
      this.props.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    this.props = v.id === 'beach' ? beachProps() : v.id === 'gym' ? gymProps() : v.id === 'night' ? nightProps() : null;
    if (this.props) this.scene.add(this.props);
  }
}

function skyTexture([top, mid, bottom]: [string, string, string]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  grad.addColorStop(0.6, mid);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function solid(geo: THREE.BufferGeometry, color: string, params: THREE.MeshStandardMaterialParameters = {}, outline = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, surfaceMaterial(color, params));
  m.castShadow = outline;
  m.receiveShadow = true;
  if (outline) addOutline(m, 0.0011);
  return m;
}

/** Palms along the sand and a sea out past the far end. */
function beachProps(): THREE.Group {
  const g = new THREE.Group();
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 300).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#2fb0d8', roughness: 0.25, metalness: 0.1 }),
  );
  sea.position.set(0, 0.02, -210);
  g.add(sea);
  const spots: [number, number][] = [[-30, -40], [30, -44], [-36, 6], [34, 10], [-48, -70], [52, -64], [-26, 26], [40, -12]];
  spots.forEach(([x, z], i) => {
    const lean = (i % 2 ? 1 : -1) * 0.18;
    const trunk = solid(new THREE.CylinderGeometry(0.4, 0.6, 14, 8).translate(0, 7, 0), '#9b6b3c', { roughness: 1 });
    trunk.position.set(x, 0, z);
    trunk.rotation.z = lean;
    g.add(trunk);
    for (let k = 0; k < 6; k++) {
      const frond = solid(new THREE.ConeGeometry(0.9, 6.5, 5).rotateZ(Math.PI / 2).translate(3, 0, 0), '#3f9a4a', { roughness: 0.9 });
      frond.position.set(x - Math.sin(lean) * 14, 13.6, z);
      frond.rotation.set(0, (k / 6) * Math.PI * 2, -0.5);
      g.add(frond);
    }
  });
  return g;
}

/** Four walls, a ceiling and a row of bright light panels. */
function gymProps(): THREE.Group {
  const g = new THREE.Group();
  // Open-ended "boxes" (4-sided tubes) so no floor face covers the court.
  const tube = (w: number, h: number, d: number, y: number) =>
    new THREE.CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2, 1, 4, 1, true)
      .rotateY(Math.PI / 4)
      .scale(w, h, d)
      .translate(0, y, -10);
  const walls = new THREE.Mesh(tube(110, 34, 140, 17), new THREE.MeshStandardMaterial({ color: '#e8e1d6', roughness: 0.95, side: THREE.BackSide }));
  walls.receiveShadow = true;
  g.add(walls);
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(110, 140).rotateX(Math.PI / 2).translate(0, 34, -10),
    new THREE.MeshStandardMaterial({ color: '#d9d2c6', roughness: 1 }),
  );
  g.add(ceiling);
  const stripe = new THREE.Mesh(tube(109.6, 3, 139.6, 5), new THREE.MeshStandardMaterial({ color: '#3a6fb0', roughness: 0.9, side: THREE.BackSide }));
  g.add(stripe);
  for (let x = -24; x <= 24; x += 16) {
    for (let z = -40; z <= 30; z += 18) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 3), new THREE.MeshBasicMaterial({ color: '#fffbe8' }));
      panel.position.set(x, 33.5, z);
      g.add(panel);
    }
  }
  return g;
}

/** Tall light towers at the corners, glowing. */
function nightProps(): THREE.Group {
  const g = new THREE.Group();
  for (const [x, z] of [[-24, -40], [24, -40], [-24, 38], [24, 38]]) {
    const pole = solid(new THREE.CylinderGeometry(0.35, 0.5, 34, 8).translate(0, 17, 0), '#3a3f4b', { metalness: 0.6, roughness: 0.4 });
    pole.position.set(x, 0, z);
    g.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(5, 2.6, 1), new THREE.MeshBasicMaterial({ color: '#fffbe8' }));
    head.position.set(x * 0.94, 34, z * 0.97);
    head.lookAt(0, 0, 0);
    g.add(head);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(5, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#fff4c2', transparent: true, opacity: 0.18, depthWrite: false }),
    );
    glow.position.copy(head.position);
    g.add(glow);
  }
  return g;
}
