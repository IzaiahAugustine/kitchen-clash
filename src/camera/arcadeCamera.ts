import * as THREE from 'three';
import type { CameraPreset } from '../game/settings';

interface CameraFraming {
  height: number;
  /** Distance behind the net (z). */
  back: number;
  /** Point on the court (z) the camera looks at. */
  lookZ: number;
  fov: number;
}

/** Close brings the court up big; Classic is the old arcade-tennis framing; Wide shows the surroundings. */
const FRAMINGS: Record<CameraPreset, CameraFraming> = {
  close: { height: 19, back: 41, lookZ: 7, fov: 44 },
  classic: { height: 24, back: 52, lookZ: 4, fov: 38 },
  wide: { height: 29, back: 61, lookZ: 3, fov: 40 },
};

/**
 * Classic arcade-tennis camera: high up behind the near baseline, looking down the court.
 * Drifts sideways a little to follow the action. Can also slowly orbit (title screen).
 */
export class ArcadeCamera {
  readonly camera: THREE.PerspectiveCamera;
  private focusX = 0;
  private framing = FRAMINGS.close;
  private aspect: number;
  private orbitAngle = 0;
  private shakeAmp = 0;

  constructor(aspect: number) {
    this.aspect = aspect;
    this.camera = new THREE.PerspectiveCamera(this.framing.fov, aspect, 0.5, 600);
    this.resize(aspect);
    this.update(0, 0);
  }

  /** Kick the camera (0..1); it settles quickly. */
  shake(amount: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
  }

  private applyShake(dt: number): void {
    if (this.shakeAmp <= 0.001) return;
    const a = this.shakeAmp * 0.6;
    this.camera.position.x += (Math.random() - 0.5) * a;
    this.camera.position.y += (Math.random() - 0.5) * a;
    this.shakeAmp *= Math.exp(-14 * dt);
  }

  setPreset(p: CameraPreset): void {
    this.framing = FRAMINGS[p];
    this.resize(this.aspect);
  }

  /** @param targetX x position to follow (usually the ball or your player). */
  update(dt: number, targetX: number): void {
    const f = this.framing;
    const k = dt > 0 ? 1 - Math.exp(-2.5 * dt) : 1;
    this.focusX += (targetX * 0.3 - this.focusX) * k;
    this.camera.position.set(this.focusX, f.height, f.back);
    this.camera.lookAt(this.focusX * 0.5, 0, f.lookZ);
    this.applyShake(dt);
  }

  /** Slow cinematic orbit around the court (title screen). */
  orbit(dt: number): void {
    this.orbitAngle += dt * 0.07;
    const r = 58;
    const a = this.orbitAngle;
    this.camera.position.set(Math.sin(a) * r, 20 + Math.sin(a * 0.7) * 4, Math.cos(a) * r);
    this.camera.lookAt(0, 2, 0);
  }

  resize(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    const base = this.framing.fov;
    // Narrow / portrait screens widen the view so both sidelines stay visible.
    this.camera.fov = aspect < 1.3 ? Math.min(75, base * (1.3 / aspect) ** 0.85) : base;
    this.camera.updateProjectionMatrix();
  }
}
