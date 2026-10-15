import * as THREE from 'three';
import type { Ball } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { addOutline, surfaceMaterial } from './materials';

/** Drawn bigger than the real ball so it reads clearly from the arcade camera. Physics is unaffected. */
const VISUAL_SCALE = 1.8;
const TRAIL_POINTS = 48;

export class BallView {
  readonly mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private trail: THREE.Line;
  private trailPositions = new Float32Array(TRAIL_POINTS * 3);
  private trailCount = 0;
  private spinAxis = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const r = PHYS.ballRadius * VISUAL_SCALE;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 18), surfaceMaterial(0xffffff, { map: ballTexture(), roughness: 0.45 }));
    addOutline(this.mesh, 0.002);

    // Blob shadow straight below the ball: the most important depth cue from a high camera.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(r * 1.3, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x0b1a33, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.shadow.renderOrder = 1;

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trail = new THREE.Line(
      trailGeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
    );
    this.trail.frustumCulled = false;

    scene.add(this.mesh, this.shadow, this.trail);
  }

  update(ball: Ball, dt: number): void {
    // Lift the drawn ball so the enlarged sphere still sits on the court when it bounces.
    const lift = PHYS.ballRadius * (VISUAL_SCALE - 1);
    this.mesh.position.set(ball.pos.x, ball.pos.y + lift, ball.pos.z);

    const w = ball.spin.length();
    if (w > 0.01) {
      this.spinAxis.copy(ball.spin).divideScalar(w);
      this.mesh.rotateOnWorldAxis(this.spinAxis, w * dt);
    }

    const h = Math.max(0, ball.pos.y - PHYS.ballRadius);
    const s = 1 / (1 + h * 0.09);
    this.shadow.position.set(ball.pos.x, 0.045, ball.pos.z);
    this.shadow.scale.setScalar(0.6 + 0.4 * s);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.45 * s;

    if (ball.inPlay) this.pushTrail(this.mesh.position);
  }

  clearTrail(): void {
    this.trailCount = 0;
    this.trail.geometry.setDrawRange(0, 0);
  }

  private pushTrail(p: THREE.Vector3): void {
    const a = this.trailPositions;
    if (this.trailCount < TRAIL_POINTS) this.trailCount++;
    a.copyWithin(3, 0, (TRAIL_POINTS - 1) * 3);
    a[0] = p.x;
    a[1] = p.y;
    a[2] = p.z;
    const geo = this.trail.geometry;
    geo.setDrawRange(0, this.trailCount);
    geo.attributes.position.needsUpdate = true;
  }
}

/** Yellow ball with darker "holes" so you can see it spin. */
function ballTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffe23a';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#d9a900';
  for (let row = 1; row < 4; row++) {
    const count = row === 2 ? 8 : 6;
    for (let i = 0; i < count; i++) {
      const x = ((i + (row % 2) * 0.5) / count) * 256;
      g.beginPath();
      g.arc(x, row * 32, 9, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
