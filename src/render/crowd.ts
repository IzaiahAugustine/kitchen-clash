import * as THREE from 'three';

// Bleacher layout from tools/blender/build_court.py.
const FENCE_X = 17;
const FENCE_Z = 32;
const STEP_H = 1.3;
const STEP_D = 2.4;
const ROWS = 4;

const SHIRTS = ['#ff6b35', '#ffd23f', '#00b4d8', '#7b2ff7', '#e63946', '#2a9d8f', '#f4a261', '#ffffff', '#3d5a80', '#ff8fab'];
const SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0673b'];
const HAIR = ['#1b1530', '#4a2f1b', '#2b1b10', '#d4a24c', '#6b3e26', '#9a9a9a'];

interface Fan {
  x: number;
  y: number;
  z: number;
  /** Facing angle (toward the court). */
  yaw: number;
  phase: number;
  bounce: number;
}

/** Spectators in the bleachers: instanced bodies, heads and hair that sway and bob a little. */
export class Crowd {
  private fans: Fan[] = [];
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private hair: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  /** 0..1 cheer level; decays (crowd reactions come in a later phase). */
  excitement = 0;

  constructor(scene: THREE.Scene) {
    let seed = 3;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let row = 0; row < ROWS; row++) {
      const seatY = (row + 1) * STEP_H;
      const farZ = -(FENCE_Z + 2 + STEP_D * (row + 0.5));
      for (let x = -14; x <= 14; x += 1.7) {
        if (r() < 0.72) this.fans.push({ x: x + (r() - 0.5) * 0.5, y: seatY, z: farZ, yaw: 0, phase: r() * 10, bounce: 0 });
      }
      const sideX = -(FENCE_X + 2 + STEP_D * (row + 0.5));
      for (let z = -22; z <= 14; z += 1.7) {
        if (r() < 0.72) this.fans.push({ x: sideX, y: seatY, z: z + (r() - 0.5) * 0.5, yaw: -Math.PI / 2, phase: r() * 10, bounce: 0 });
      }
    }

    const n = this.fans.length;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    this.bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.4, 0.55, 4, 10), mat, n);
    this.heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 14, 10), mat.clone(), n);
    this.hair = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.32, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      mat.clone(),
      n,
    );
    const color = new THREE.Color();
    this.fans.forEach((_, i) => {
      this.bodies.setColorAt(i, color.set(SHIRTS[Math.floor(r() * SHIRTS.length)]));
      this.heads.setColorAt(i, color.set(SKINS[Math.floor(r() * SKINS.length)]));
      this.hair.setColorAt(i, color.set(HAIR[Math.floor(r() * HAIR.length)]));
    });
    for (const mesh of [this.bodies, this.heads, this.hair]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    this.update(0, 0);
  }

  /** Make the crowd jump and cheer (0..1). */
  cheer(level: number): void {
    this.excitement = Math.max(this.excitement, level);
  }

  update(time: number, dt: number): void {
    this.excitement = Math.max(0, this.excitement - dt * 0.5);
    this.fans.forEach((f, i) => {
      const sway = Math.sin(time * 1.3 + f.phase) * 0.05;
      const hop = this.excitement * Math.max(0, Math.sin(time * 9 + f.phase)) * 0.5;
      this.q.setFromAxisAngle(this.up, f.yaw + sway);
      const y = f.y + 0.7 + hop;
      this.m.compose(this.v.set(f.x, y, f.z), this.q, this.s);
      this.bodies.setMatrixAt(i, this.m);
      this.m.compose(this.v.set(f.x, y + 0.98, f.z), this.q, this.s);
      this.heads.setMatrixAt(i, this.m);
      this.m.compose(this.v.set(f.x, y + 1.04, f.z), this.q, this.s);
      this.hair.setMatrixAt(i, this.m);
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.hair.instanceMatrix.needsUpdate = true;
  }
}
