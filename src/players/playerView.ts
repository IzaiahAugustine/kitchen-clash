import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addOutline, surfaceMaterial } from '../render/materials';
import { BODY, legPose } from './body';
import type { Palette } from './palette';
import { RECOVER_TIME, type Player, type Swing } from './player';
import { READY_POSE, lerpPose, type ArmPose } from './swingPoses';

/** Loads the Blender-built player (public/models/player.glb) once; clone it per player. */
export async function loadPlayerTemplate(): Promise<THREE.Object3D> {
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/player.glb`);
  mergeParts(gltf.scene);
  return gltf.scene;
}

/**
 * The model has ~55 separate parts. Parts that move together (same joint) and look the same
 * (same material, same outline treatment) are merged into one mesh, cutting draw calls ~3x.
 */
function mergeParts(root: THREE.Object3D): void {
  const joints: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name.startsWith('j_')) joints.push(o);
  });
  for (const joint of joints) {
    const groups = new Map<string, THREE.Mesh[]>();
    for (const child of joint.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      const prefix = mesh.name.startsWith('ol_') ? 'ol_' : 'flat_';
      const key = `${prefix}${(mesh.material as THREE.Material).name}`;
      groups.set(key, [...(groups.get(key) ?? []), mesh]);
    }
    for (const [key, meshes] of groups) {
      const geos = meshes.map((m) => {
        m.updateMatrix();
        const g = m.geometry.clone().applyMatrix4(m.matrix);
        for (const name of Object.keys(g.attributes)) {
          if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
        }
        return g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]);
      });
      const merged = new THREE.Mesh(mergeGeometries(geos)!, meshes[0].material);
      merged.name = `${key}_${joint.name}`;
      for (const m of meshes) joint.remove(m);
      joint.add(merged);
    }
  }
}

const JOINTS = [
  'j_root', 'j_hips', 'j_spine', 'j_neck',
  'j_shoulder_R', 'j_elbow_R', 'j_shoulder_L', 'j_elbow_L',
  'j_hip_R', 'j_knee_R', 'j_hip_L', 'j_knee_L',
] as const;
type JointName = (typeof JOINTS)[number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Per-material surface feel: skin has a soft sheen, the paddle is glossy, fabric is matte. */
const SURFACE: Record<string, THREE.MeshStandardMaterialParameters> = {
  skin: { roughness: 0.55 },
  lips: { roughness: 0.45 },
  hair: { roughness: 0.6 },
  eye_white: { roughness: 0.2 },
  iris: { roughness: 0.15 },
  pupil: { roughness: 0.1 },
  paddle: { roughness: 0.3 },
  paddle_edge: { roughness: 0.4 },
  shoe: { roughness: 0.6 },
};

/** Lips: the skin tone, a little darker and redder. */
function lipColor(skin: string): string {
  const c = new THREE.Color(skin);
  c.offsetHSL(-0.02, 0.12, -0.14);
  return `#${c.getHexString()}`;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Time to swing the paddle from wind-up to contact. */
const FORWARD_SWING = 0.13;

/** A player's 3D model, recolored with their palette and animated procedurally each frame. */
export class PlayerView {
  readonly root: THREE.Object3D;
  private j = {} as Record<JointName, THREE.Object3D>;
  private phase = Math.random() * 10;
  private yaw = Number.NaN;
  private prevVel = new THREE.Vector3();
  private accel = new THREE.Vector3();

  constructor(template: THREE.Object3D, palette: Palette) {
    this.root = template.clone(true);
    const meshes: THREE.Mesh[] = [];
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const materials = new Map<string, THREE.Material>();
    const colors = { ...palette, lips: lipColor(palette.skin) } as unknown as Record<string, string>;
    for (const mesh of meshes) {
      const n = mesh.name;
      const src = mesh.material as THREE.MeshStandardMaterial;
      const slot = src.name;
      // Only show the headwear this player wears.
      if ((slot === 'cap' && palette.headwear !== 'cap') || (slot === 'headband' && palette.headwear !== 'headband')) {
        mesh.visible = false;
        continue;
      }
      let m = materials.get(slot);
      if (!m) {
        m = surfaceMaterial(colors[slot] ?? src.color, SURFACE[slot] ?? {});
        materials.set(slot, m);
      }
      mesh.material = m;
      mesh.castShadow = !n.startsWith('flat_');
      mesh.receiveShadow = true;
      if (n.startsWith('ol_')) addOutline(mesh, 0.0013);
    }
    for (const name of JOINTS) {
      const joint = this.root.getObjectByName(name);
      if (!joint) throw new Error(`player model is missing joint ${name}`);
      this.j[name] = joint;
    }
    this.j.j_shoulder_R.rotation.order = 'YZX';
    this.j.j_shoulder_L.rotation.order = 'YZX';
  }

  /** @param ball ball position, so the head can follow it */
  update(player: Player, time: number, dt: number, ball: THREE.Vector3): void {
    const j = this.j;
    const vx = player.vel.x;
    const vz = player.vel.z;
    const speed = Math.hypot(vx, vz);
    const fwd = player.forward;
    const right = player.right;
    // Velocity and (smoothed) acceleration in the player's own frame.
    const vf = vx * fwd.x + vz * fwd.z;
    const vr = vx * right.x + vz * right.z;
    if (dt > 0) {
      const k = 1 - Math.exp(-10 * dt);
      this.accel.x += ((vx - this.prevVel.x) / dt - this.accel.x) * k;
      this.accel.z += ((vz - this.prevVel.z) / dt - this.accel.z) * k;
    }
    this.prevVel.set(vx, 0, vz);
    const af = this.accel.x * fwd.x + this.accel.z * fwd.z;
    const ar = this.accel.x * right.x + this.accel.z * right.z;

    // Long sideways runs turn the body into a run; short moves stay square and shuffle.
    const sideW = speed > 0.1 ? Math.abs(vr) / speed : 0;
    const turn = player.swing ? 0 : clamp01((speed - 7) / 5) * sideW;
    const targetYaw = player.yaw - Math.sign(vr) * 0.6 * turn;
    if (Number.isNaN(this.yaw)) this.yaw = player.yaw;
    this.yaw += (targetYaw - this.yaw) * (1 - Math.exp(-8 * dt));
    const yawOffset = this.yaw - player.yaw;
    this.root.position.copy(player.pos);
    this.root.rotation.y = this.yaw;

    // Steps follow distance covered (no skating): longer strides at higher speed.
    const stride = 1.5 + speed * 0.1;
    this.phase += ((speed * dt) / stride) * Math.PI;
    const s = Math.sin(this.phase);
    const moving = clamp01(speed / 3);
    const runAmt = clamp01(speed / 14);
    const shuffleW = sideW * (1 - turn);
    const runW = 1 - shuffleW;
    const backpedal = vf < -0.5 && turn < 0.5;

    const arm = player.swing ? swingPose(player.swing, time) : READY_POSE;
    let crouch = arm.crouch * (1 - runAmt * 0.4) + 0.12 * shuffleW * moving;
    let hop = 0;

    // Split step: a little hop as the opponent strikes, landing low and ready.
    const k = time - player.splitStepAt;
    if (k >= 0 && k < 0.4 && !player.swing && speed < 6) {
      if (k < 0.16) hop = Math.sin((Math.PI * k) / 0.16) * 0.2;
      else crouch += (1 - (k - 0.16) / 0.24) * 0.25;
    }
    const legs = legPose(crouch);

    const amp = moving * (0.3 + 0.5 * runAmt) * runW * (backpedal ? 0.6 : 1);
    const spread = 0.26 * shuffleW * moving * (0.5 + 0.5 * s);
    const breathe = speed < 0.5 ? Math.sin(time * 2.2) : 0;
    j.j_hips.position.y =
      BODY.hipsY - legs.drop + hop +
      Math.abs(Math.cos(this.phase)) * 0.1 * runAmt * runW +
      Math.abs(s) * 0.05 * shuffleW * moving +
      breathe * 0.015;
    j.j_hip_R.rotation.set(legs.hip + s * amp, 0, spread);
    j.j_hip_L.rotation.set(legs.hip - s * amp, 0, -spread);
    // Knee folds on the leg that's swinging through (reversed when backpedaling).
    const foldR = Math.max(0, backpedal ? s : -s);
    const foldL = Math.max(0, backpedal ? -s : s);
    j.j_knee_R.rotation.set(legs.knee - foldR * 1.1 * amp, 0, 0);
    j.j_knee_L.rotation.set(legs.knee - foldL * 1.1 * amp, 0, 0);

    // Lean into acceleration (forward when pushing off, back when braking, sideways into cuts).
    const lean = (v: number) => Math.max(-40, Math.min(40, v));
    j.j_spine.rotation.set(
      -0.1 * runAmt * runW * (backpedal ? -0.4 : 1) - lean(af) * 0.006 - crouch * 0.3 + breathe * 0.02,
      arm.spineY,
      -lean(ar) * 0.005,
    );

    // Head tracks the ball.
    const dx = ball.x - player.pos.x;
    const dz = ball.z - player.pos.z;
    const lx = dx * right.x + dz * right.z;
    const lz = -(dx * fwd.x + dz * fwd.z);
    const look = Math.max(-0.9, Math.min(0.9, Math.atan2(-lx, -lz) - yawOffset - arm.spineY));
    const pitch = Math.max(-0.5, Math.min(0.5, Math.atan2(ball.y - BODY.headY, Math.hypot(lx, lz))));
    j.j_neck.rotation.set(crouch * 0.25 + pitch * 0.6, look * 0.8, 0);

    // Paddle arm swings a little while running; off arm pumps, or flares for balance in a swing.
    const pump = player.swing ? 0 : s * 0.25 * runAmt * runW;
    j.j_shoulder_R.rotation.set(arm.sx + pump, arm.sy, arm.sz);
    j.j_elbow_R.rotation.set(arm.ex, 0, 0);
    j.j_shoulder_L.rotation.set(0.35 + s * 0.6 * runAmt * runW, 0, player.swing ? -0.55 : -0.3 - 0.2 * shuffleW * moving);
    j.j_elbow_L.rotation.set(0.7 + 0.4 * runAmt, 0, 0);
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
