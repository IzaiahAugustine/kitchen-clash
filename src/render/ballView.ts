import * as THREE from 'three';
import type { Ball } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { addOutline, surfaceMaterial } from './materials';

/** Drawn bigger than the real ball so it reads clearly from the arcade camera. Physics is unaffected. */
const VISUAL_SCALE = 1.8;
const TRAIL_POINTS = 28;

const trailVertex = /* glsl */ `
  attribute float alpha;
  varying float vAlpha;
  void main() {
    vAlpha = alpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const trailFragment = /* glsl */ `
  uniform vec3 color;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(color, vAlpha); }`;

export class BallView {
  readonly mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private trail: THREE.Mesh;
  private points: THREE.Vector3[] = [];
  private trailPos = new Float32Array(TRAIL_POINTS * 2 * 3);
  private trailAlpha = new Float32Array(TRAIL_POINTS * 2);
  private spinAxis = new THREE.Vector3();
  private squashT = 1;
  private squashAmt = 0;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

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

    // Tapered ribbon that always faces the camera, fading toward the tail.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.trailAlpha, 1));
    const index: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(index);
    this.trail = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(0xfff6c8) } },
        vertexShader: trailVertex,
        fragmentShader: trailFragment,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 2;

    scene.add(this.mesh, this.shadow, this.trail);
  }

  /** Squash the ball briefly when it bounces (harder bounces squash more). */
  squash(impactSpeed: number): void {
    this.squashT = 0;
    this.squashAmt = Math.min(0.35, impactSpeed / 80);
  }

  update(ball: Ball, dt: number, camera?: THREE.Camera): void {
    // Lift the drawn ball so the enlarged sphere still sits on the court when it bounces.
    const lift = PHYS.ballRadius * (VISUAL_SCALE - 1);
    this.mesh.position.set(ball.pos.x, ball.pos.y + lift, ball.pos.z);

    this.squashT = Math.min(1, this.squashT + dt / 0.12);
    const sq = this.squashAmt * Math.sin(this.squashT * Math.PI);
    this.mesh.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);

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

    if (ball.inPlay && dt > 0) {
      this.points.unshift(this.mesh.position.clone());
      if (this.points.length > TRAIL_POINTS) this.points.pop();
    }
    if (camera) this.buildTrail(camera, ball.vel.length());
  }

  clearTrail(): void {
    this.points = [];
    this.trailAlpha.fill(0);
    this.trail.geometry.attributes.alpha.needsUpdate = true;
  }

  private buildTrail(camera: THREE.Camera, speed: number): void {
    const n = this.points.length;
    const width = PHYS.ballRadius * VISUAL_SCALE * 0.9;
    // Faster balls leave a more visible streak, glowing orange on the really hard hits.
    const strength = Math.min(0.75, 0.2 + speed / 90);
    const hot = Math.min(1, Math.max(0, (speed - 50) / 25));
    (this.trail.material as THREE.ShaderMaterial).uniforms.color.value.setRGB(1, 0.96 - hot * 0.5, 0.78 - hot * 0.62);
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const p = this.points[Math.min(i, n - 1)];
      if (!p || n < 2) {
        this.trailAlpha[i * 2] = this.trailAlpha[i * 2 + 1] = 0;
        continue;
      }
      const prev = this.points[Math.max(0, Math.min(i, n - 1) - 1)];
      const next = this.points[Math.min(n - 1, i + 1)];
      const dir = this.tmpA.subVectors(prev, next);
      const view = this.tmpB.subVectors(camera.position, p);
      const side = dir.cross(view).normalize();
      const k = 1 - i / TRAIL_POINTS;
      side.multiplyScalar(width * k);
      this.trailPos.set([p.x + side.x, p.y + side.y, p.z + side.z], i * 6);
      this.trailPos.set([p.x - side.x, p.y - side.y, p.z - side.z], i * 6 + 3);
      const a = i < n ? strength * k * k : 0;
      this.trailAlpha[i * 2] = this.trailAlpha[i * 2 + 1] = a;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.alpha.needsUpdate = true;
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
