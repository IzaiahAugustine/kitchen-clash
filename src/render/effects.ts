import * as THREE from 'three';

interface Burst {
  ring: THREE.Mesh;
  sparks: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number;
}

const SPARK_COUNT = 14;

/** Visual juice: hit bursts, the incoming-ball landing marker and the serve target box. */
export class Effects {
  private bursts: Burst[] = [];
  private ringGeo = new THREE.RingGeometry(0.55, 0.75, 32);
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

  update(dt: number, camera: THREE.Camera): void {
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
