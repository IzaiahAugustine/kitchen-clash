import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { addOutline, toonMaterial } from '../render/toon';
import { BODY, legPose } from './body';
import type { Palette } from './palette';
import { RECOVER_TIME, type Player, type Swing } from './player';
import { READY_POSE, lerpPose, type ArmPose } from './swingPoses';

/** Loads the Blender-built player (public/models/player.glb) once; clone it per player. */
export async function loadPlayerTemplate(): Promise<THREE.Object3D> {
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/player.glb`);
  return gltf.scene;
}

const JOINTS = [
  'j_root', 'j_hips', 'j_spine', 'j_neck',
  'j_shoulder_R', 'j_elbow_R', 'j_shoulder_L', 'j_elbow_L',
  'j_hip_R', 'j_knee_R', 'j_hip_L', 'j_knee_L',
] as const;
type JointName = (typeof JOINTS)[number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Time to swing the paddle from wind-up to contact. */
const FORWARD_SWING = 0.13;

/** A player's 3D model, recolored with their palette and animated procedurally each frame. */
export class PlayerView {
  readonly root: THREE.Object3D;
  private j = {} as Record<JointName, THREE.Object3D>;
  private runPhase = Math.random() * 10;

  constructor(template: THREE.Object3D, palette: Palette) {
    this.root = template.clone(true);
    const meshes: THREE.Mesh[] = [];
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const materials = new Map<string, THREE.Material>();
    for (const mesh of meshes) {
      const src = mesh.material as THREE.MeshStandardMaterial;
      const slot = src.name;
      let m = materials.get(slot);
      if (!m) {
        const color = (palette as unknown as Record<string, string>)[slot] ?? src.color;
        m = toonMaterial(color);
        materials.set(slot, m);
      }
      mesh.material = m;
      mesh.castShadow = true;
      if (mesh.name.startsWith('ol_')) addOutline(mesh, 0.0022);
    }
    for (const name of JOINTS) {
      const joint = this.root.getObjectByName(name);
      if (!joint) throw new Error(`player model is missing joint ${name}`);
      this.j[name] = joint;
    }
    this.j.j_shoulder_R.rotation.order = 'YZX';
    this.j.j_shoulder_L.rotation.order = 'YZX';
  }

  update(player: Player, time: number, dt: number): void {
    const j = this.j;
    this.root.position.copy(player.pos);
    this.root.rotation.y = player.yaw;

    const speed = Math.hypot(player.vel.x, player.vel.z);
    const run = clamp01(speed / 13);
    this.runPhase += dt * (5 + speed * 0.7);
    const s = Math.sin(this.runPhase);

    const arm = player.swing ? swingPose(player.swing, time) : READY_POSE;
    const crouch = arm.crouch * (1 - run * 0.4);
    const legs = legPose(crouch);

    j.j_hips.position.y = BODY.hipsY - legs.drop + Math.abs(Math.cos(this.runPhase)) * 0.12 * run;
    j.j_hip_R.rotation.set(legs.hip + s * 0.8 * run, 0, 0);
    j.j_hip_L.rotation.set(legs.hip - s * 0.8 * run, 0, 0);
    j.j_knee_R.rotation.set(legs.knee - Math.max(0, -s) * 1.1 * run, 0, 0);
    j.j_knee_L.rotation.set(legs.knee - Math.max(0, s) * 1.1 * run, 0, 0);

    j.j_spine.rotation.set(-0.12 * run - crouch * 0.3, arm.spineY, 0);
    j.j_neck.rotation.set(crouch * 0.25 + 0.06 * run, -arm.spineY * 0.6, 0);

    j.j_shoulder_R.rotation.set(arm.sx, arm.sy, arm.sz);
    j.j_elbow_R.rotation.set(arm.ex, 0, 0);

    // Off arm: pumps while running, flares out for balance during a swing.
    j.j_shoulder_L.rotation.set(0.35 + s * 0.6 * run, 0, player.swing ? -0.55 : -0.3);
    j.j_elbow_L.rotation.set(0.7 + 0.3 * run, 0, 0);
  }
}

/** Ready → wind-up (held until it's time) → fast forward swing → contact → follow-through → ready. */
function swingPose(sw: Swing, time: number): ArmPose {
  const { wind, contact, follow } = sw.poses;
  const windEnd = Math.max(sw.startAt, sw.contactAt - FORWARD_SWING);
  if (time < windEnd) {
    const p = clamp01((time - sw.startAt) / Math.max(0.08, (windEnd - sw.startAt) * 0.6));
    return lerpPose(READY_POSE, wind, smooth(p));
  }
  if (time < sw.contactAt) {
    const p = clamp01((time - windEnd) / Math.max(1e-3, sw.contactAt - windEnd));
    return lerpPose(wind, contact, p * p);
  }
  if (time < sw.endAt) {
    const p = clamp01((time - sw.contactAt) / (sw.endAt - sw.contactAt));
    return lerpPose(contact, follow, 1 - (1 - p) * (1 - p));
  }
  return lerpPose(follow, READY_POSE, smooth(clamp01((time - sw.endAt) / RECOVER_TIME)));
}
