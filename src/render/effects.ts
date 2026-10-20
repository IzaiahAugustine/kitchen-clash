import * as THREE from 'three';

interface Burst {
  ring: THREE.Mesh;
  sparks: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number;
}

const SPARK_COUNT = 14;
const DUST_COUNT = 10;
const CONFETTI_COUNT = 160;
const CONFETTI_COLORS = [0xff6b35, 0xffd23f, 0x2ec4b6, 0x7b2ff7, 0xff3d7f, 0xffffff];

/** Particles with their own velocities, fading out over `life` seconds. */
interface Puff {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number;
  gravity: number;
  drag: number;
  ring?: THREE.Mesh;
}

/** Visual juice: hit bursts, bounce impacts, confetti, the landing marker and the serve target box. */
export class Effects {
  private bursts: Burst[] = [];
  private puffs: Puff[] = [];
  private ringGeo = new THREE.RingGeometry(0.55, 0.75, 32);
  private groundRingGeo = new THREE.RingGeometry(0.7, 1, 40).rotateX(-Math.PI / 2);
  private landing: THREE.Mesh;
  private serveBox: THREE.Mesh;
  private pulse = 0;

  constructor(private scene: THREE.Scene) {
    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.55, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe23a, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.landing.renderOrder = 3;
    this.landing.visible = false;
    this.serveBox = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe23a, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    this.serveBox.renderOrder = 2;
    this.serveBox.visible = false;
    scene.add(this.landing, this.serveBox);
  }

  /** Where the incoming ball will first bounce (null hides the marker). */
  setLanding(p: THREE.Vector3 | null): void {
    this.landing.visible = !!p;
    if (p) this.landing.position.set(p.x, 0.06, p.z);
  }

  /** Highlights the service box the serve must land in (null hides it). */
  setServeBox(box: { x0: number; x1: number; z0: number; z1: number } | null): void {
    this.serveBox.visible = !!box;
    if (!box) return;
    this.serveBox.position.set((box.x0 + box.x1) / 2, 0.05, (box.z0 + box.z1) / 2);
    this.serveBox.scale.set(Math.abs(box.x1 - box.x0), 1, Math.abs(box.z1 - box.z0));
  }

  /** A pop of light where the paddle met the ball. `perfect` makes it big and gold. */
  burst(at: THREE.Vector3, power: number, perfect: boolean): void {
    const color = perfect ? 0xffd23f : 0xffffff;
    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.position.copy(at);
    ring.renderOrder = 4;
    const positions = new Float32Array(SPARK_COUNT * 3);
    const velocities = new Float32Array(SPARK_COUNT * 3);
    const speed = (perfect ? 14 : 8) * (0.5 + power);
    for (let i = 0; i < SPARK_COUNT; i++) {
      positions.set([at.x, at.y, at.z], i * 3);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      velocities.set([v.x * speed, v.y * speed, v.z * speed], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const sparks = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color, size: perfect ? 0.32 : 0.22, transparent: true, depthWrite: false }),
    );
    sparks.renderOrder = 4;
    this.scene.add(ring, sparks);
    this.bursts.push({ ring, sparks, velocities, age: 0, life: perfect ? 0.45 : 0.3 });
  }

  /** A hard bounce: a ring shooting out across the court and a puff of dust. */
  impact(at: THREE.Vector3, strength: number): void {
    const ring = new THREE.Mesh(
      this.groundRingGeo,
      new THREE.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    ring.position.set(at.x, 0.07, at.z);
    ring.renderOrder = 3;
    const v = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i++) {
      const a = (i / DUST_COUNT) * Math.PI * 2 + Math.random() * 0.4;
      const sp = (3 + Math.random() * 3) * (0.6 + strength);
      v.set([Math.cos(a) * sp, 1.5 + Math.random() * 2.5 * strength, Math.sin(a) * sp], i * 3);
    }
    this.addPuff(at.clone().setY(0.15), v, { color: 0xe9dcc0, size: 0.32 + 0.25 * strength, life: 0.5, gravity: 4, drag: 3.5, ring });
  }

  /** Celebration: a burst of confetti above a spot (you won the match). */
  confetti(at: THREE.Vector3): void {
    const v = new Float32Array(CONFETTI_COUNT * 3);
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 7;
      v.set([Math.cos(a) * r, 9 + Math.random() * 9, Math.sin(a) * r], i * 3);
    }
    const colors = new Float32Array(CONFETTI_COUNT * 3);
    const c = new THREE.Color();
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      c.setHex(CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    this.addPuff(at.clone().setY(2.5), v, { size: 0.3, life: 3.2, gravity: 9, drag: 1.4, colors });
  }

  private addPuff(
    at: THREE.Vector3,
    velocities: Float32Array,
    o: { color?: number; size: number; life: number; gravity: number; drag: number; ring?: THREE.Mesh; colors?: Float32Array },
  ): void {
    const n = velocities.length / 3;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) positions.set([at.x, at.y, at.z], i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (o.colors) geo.setAttribute('color', new THREE.BufferAttribute(o.colors, 3));
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: o.colors ? 0xffffff : o.color, vertexColors: !!o.colors, size: o.size, transparent: true, depthWrite: false }),
    );
    points.renderOrder = 4;
    this.scene.add(points);
    if (o.ring) this.scene.add(o.ring);
    this.puffs.push({ points, velocities, age: 0, life: o.life, gravity: o.gravity, drag: o.drag, ring: o.ring });
  }

  private updatePuffs(dt: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      const k = p.age / p.life;
      const pos = p.points.geometry.attributes.position as THREE.BufferAttribute;
      const v = p.velocities;
      const slow = Math.exp(-p.drag * dt);
      for (let j = 0; j < v.length / 3; j++) {
        v[j * 3] *= slow;
        v[j * 3 + 2] *= slow;
        v[j * 3 + 1] = v[j * 3 + 1] * slow - p.gravity * dt;
        pos.setXYZ(j, pos.getX(j) + v[j * 3] * dt, Math.max(0.05, pos.getY(j) + v[j * 3 + 1] * dt), pos.getZ(j) + v[j * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      (p.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - k * k);
      if (p.ring) {
        p.ring.scale.setScalar(0.4 + Math.min(1, k * 2.2) * 2.6);
        (p.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.6 * (1 - k * 1.8));
      }
      if (k >= 1) {
        this.scene.remove(p.points);
        p.points.geometry.dispose();
        (p.points.material as THREE.Material).dispose();
        if (p.ring) {
          this.scene.remove(p.ring);
          (p.ring.material as THREE.Material).dispose();
        }
        this.puffs.splice(i, 1);
      }
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.updatePuffs(dt);
    this.pulse += dt;
    if (this.landing.visible) {
      const s = 1 + Math.sin(this.pulse * 10) * 0.12;
      this.landing.scale.set(s, 1, s);
    }
    if (this.serveBox.visible) {
      (this.serveBox.material as THREE.MeshBasicMaterial).opacity = 0.14 + Math.sin(this.pulse * 4) * 0.06;
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.age += dt;
      const k = b.age / b.life;
      b.ring.quaternion.copy(camera.quaternion);
      b.ring.scale.setScalar(0.3 + k * 1.6);
      (b.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k);
      const pos = b.sparks.geometry.attributes.position as THREE.BufferAttribute;
      for (let j = 0; j < SPARK_COUNT; j++) {
        b.velocities[j * 3 + 1] -= 30 * dt;
        pos.setXYZ(
          j,
          pos.getX(j) + b.velocities[j * 3] * dt,
          pos.getY(j) + b.velocities[j * 3 + 1] * dt,
          pos.getZ(j) + b.velocities[j * 3 + 2] * dt,
        );
      }
      pos.needsUpdate = true;
      (b.sparks.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - k);
      if (k >= 1) {
        this.scene.remove(b.ring, b.sparks);
        (b.ring.material as THREE.Material).dispose();
        b.sparks.geometry.dispose();
        (b.sparks.material as THREE.Material).dispose();
        this.bursts.splice(i, 1);
      }
    }
  }
}
