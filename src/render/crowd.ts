import * as THREE from 'three';

// Bleacher layout from tools/blender/build_court.py.
const FENCE_X = 17;
const FENCE_Z = 32;
const STEP_H = 1.3;
const STEP_D = 2.4;
const ROWS = 4;

const SHIRTS = ['#ff6b35', '#ffd23f', '#00b4d8', '#7b2ff7', '#e63946', '#2a9d8f', '#f4a261', '#ffffff', '#3d5a80', '#ff8fab', '#90be6d', '#1b1530'];
const SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0673b', '#5c3a21'];
const HAIR = ['#1b1530', '#4a2f1b', '#2b1b10', '#d4a24c', '#6b3e26', '#9a9a9a', '#b5651d'];
const CAPS = ['#e63946', '#ffd23f', '#1b1530', '#00b4d8', '#ffffff', '#2a9d8f'];
const SHORTS = ['#2b2d42', '#3d5a80', '#5c4033', '#1b1530', '#6c757d'];

interface Fan {
  x: number;
  y: number;
  z: number;
  /** Facing angle (toward the court). */
  yaw: number;
  phase: number;
  /** How into the game this fan is (some cheer hard, some barely clap). */
  energy: number;
  cap: boolean;
  /** Cheering style: 0 = arms up, 1 = fist pump, 2 = clap. */
  style: number;
}

/**
 * Spectators in the bleachers. Instanced (cheap): body, legs, head, hair or cap, and two arms
 * that move. Idle fans sway and chat; after a point they clap; big points get them on their
 * feet with arms in the air.
 */
export class Crowd {
  private fans: Fan[] = [];
  private bodies: THREE.InstancedMesh;
  private legs: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private hair: THREE.InstancedMesh;
  private caps: THREE.InstancedMesh;
  private armsL: THREE.InstancedMesh;
  private armsR: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private arm = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  /** 0..1 cheer level; decays. */
  excitement = 0;
  /** Light applause level (after any point); decays. */
  private applause = 0;

  constructor(scene: THREE.Scene) {
    let seed = 3;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = <T>(list: T[]) => list[Math.floor(r() * list.length)];
    const add = (x: number, y: number, z: number, yaw: number) =>
      this.fans.push({ x, y, z, yaw, phase: r() * 10, energy: 0.4 + r() * 0.6, cap: r() < 0.3, style: Math.floor(r() * 3) });
    for (let row = 0; row < ROWS; row++) {
      const seatY = (row + 1) * STEP_H;
      const farZ = -(FENCE_Z + 2 + STEP_D * (row + 0.5));
      for (let x = -14; x <= 14; x += 1.45) if (r() < 0.82) add(x + (r() - 0.5) * 0.4, seatY, farZ, Math.PI);
      const sideX = -(FENCE_X + 2 + STEP_D * (row + 0.5));
      for (let z = -22; z <= 14; z += 1.45) if (r() < 0.82) add(sideX, seatY, z + (r() - 0.5) * 0.4, -Math.PI / 2);
    }

    const n = this.fans.length;
    const mat = () => new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const mk = (geo: THREE.BufferGeometry) => {
      const mesh = new THREE.InstancedMesh(geo, mat(), n);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    };
    // Torso slightly wider at the shoulders; arms pivot at the shoulder (geometry hangs down).
    this.bodies = mk(new THREE.CylinderGeometry(0.34, 0.28, 1.0, 10).translate(0, 0.5, 0));
    this.legs = mk(new THREE.BoxGeometry(0.62, 0.32, 0.9).translate(0, 0.16, -0.25));
    this.heads = mk(new THREE.SphereGeometry(0.27, 14, 10));
    this.hair = mk(new THREE.SphereGeometry(0.29, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5));
    const capGeo = new THREE.SphereGeometry(0.3, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const brim = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 10).scale(1, 1, 1.4).translate(0, 0.02, -0.28);
    this.caps = mk(mergeTwo(capGeo, brim));
    const armGeo = new THREE.CapsuleGeometry(0.085, 0.55, 3, 8).translate(0, -0.34, 0);
    this.armsL = mk(armGeo);
    this.armsR = mk(armGeo.clone());

    const color = new THREE.Color();
    this.fans.forEach((f, i) => {
      const shirt = color.set(pick(SHIRTS)).clone();
      const skin = color.set(pick(SKINS)).clone();
      this.bodies.setColorAt(i, shirt);
      this.armsL.setColorAt(i, r() < 0.5 ? shirt : skin);
      this.armsR.setColorAt(i, r() < 0.5 ? shirt : skin);
      this.legs.setColorAt(i, color.set(pick(SHORTS)));
      this.heads.setColorAt(i, skin);
      this.hair.setColorAt(i, color.set(pick(HAIR)));
      this.caps.setColorAt(i, color.set(f.cap ? pick(CAPS) : '#000000'));
    });
    this.update(0, 0);
  }

  /** Make the crowd react (0..1): light applause for any point, on their feet for big ones. */
  cheer(level: number): void {
    this.applause = Math.max(this.applause, 0.6 + level * 0.4);
    if (level > 0.55) this.excitement = Math.max(this.excitement, level);
  }

  update(time: number, dt: number): void {
    this.excitement = Math.max(0, this.excitement - dt * 0.4);
    this.applause = Math.max(0, this.applause - dt * 0.45);
    this.fans.forEach((f, i) => {
      const hype = Math.min(1, this.excitement * (0.6 + f.energy));
      const clap = this.applause * f.energy;
      // Standing up and bouncing when hyped; small sway and the odd chat-turn otherwise.
      const stand = hype * 0.45;
      const bounce = hype * Math.max(0, Math.sin(time * 9 + f.phase)) * 0.25;
      const chat = Math.sin(time * 0.37 + f.phase * 3) > 0.92 ? Math.sin(f.phase) * 0.5 : 0;
      const sway = Math.sin(time * 1.3 + f.phase) * 0.05;
      const y = f.y + stand + bounce;
      const yaw = f.yaw + sway + chat * (1 - hype);

      this.q.setFromAxisAngle(this.up, yaw);
      this.m.compose(this.v.set(f.x, y, f.z), this.q, this.s);
      this.bodies.setMatrixAt(i, this.m);
      this.m.compose(this.v.set(f.x, f.y, f.z), this.q.setFromAxisAngle(this.up, f.yaw), this.s);
      this.legs.setMatrixAt(i, stand > 0.2 ? this.hidden : this.m);
      this.q.setFromAxisAngle(this.up, yaw);
      this.m.compose(this.v.set(f.x, y + 1.27, f.z), this.q, this.s);
      this.heads.setMatrixAt(i, this.m);
      this.m.compose(this.v.set(f.x, y + 1.31, f.z), this.q, this.s);
      this.hair.setMatrixAt(i, f.cap ? this.hidden : this.m);
      this.caps.setMatrixAt(i, f.cap ? this.m : this.hidden);

      // Arms: resting → clapping in front → thrown up (or pumping) when hyped.
      let liftL: number;
      let liftR: number;
      let fwd: number;
      if (hype > 0.2) {
        const pump = Math.sin(time * 10 + f.phase);
        if (f.style === 1) {
          liftL = 0.4;
          liftR = 2.6 + pump * 0.4;
        } else {
          liftL = liftR = 2.7 + pump * 0.15;
        }
        fwd = 0.2;
      } else if (clap > 0.15) {
        const c = Math.abs(Math.sin(time * 14 + f.phase));
        liftL = liftR = 1.25;
        fwd = 0.35 + c * 0.25;
      } else {
        liftL = liftR = 0.35;
        fwd = 0.5;
      }
      this.setArm(this.armsL, i, f, y, yaw, -1, liftL, fwd);
      this.setArm(this.armsR, i, f, y, yaw, 1, liftR, fwd);
    });
    for (const mesh of [this.bodies, this.legs, this.heads, this.hair, this.caps, this.armsL, this.armsR]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * One arm: hangs from the shoulder, swung forward by `lift` (0 = down, ~1.3 = forward,
   * ~2.7 = straight up) and in toward the body by `inward` for clapping.
   */
  private setArm(mesh: THREE.InstancedMesh, i: number, f: Fan, y: number, yaw: number, side: number, lift: number, inward: number): void {
    const shoulder = this.v.set(side * 0.36, 0.92, 0).applyAxisAngle(this.up, yaw).add(new THREE.Vector3(f.x, y, f.z));
    const rot = new THREE.Euler(lift, yaw, side * (0.15 + (lift > 2 ? 0.25 : 0)) - side * (lift > 1 && lift < 2 ? inward : 0), 'YXZ');
    this.arm.compose(shoulder, this.q.setFromEuler(rot), this.s);
    mesh.setMatrixAt(i, this.arm);
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const ai = a.toNonIndexed();
  const bi = b.toNonIndexed();
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal'] as const) {
    const A = ai.attributes[name].array as Float32Array;
    const B = bi.attributes[name].array as Float32Array;
    const out = new Float32Array(A.length + B.length);
    out.set(A);
    out.set(B, A.length);
    merged.setAttribute(name, new THREE.BufferAttribute(out, 3));
  }
  return merged;
}
