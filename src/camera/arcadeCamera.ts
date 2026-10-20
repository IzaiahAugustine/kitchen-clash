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
  private baseFov = 44;
  /** Zoom-in kick on big hits (0..1), easing back out. */
  private punchAmt = 0;

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

  /** A quick zoom toward the action that eases back (0..1). */
  punch(amount: number): void {
    this.punchAmt = Math.max(this.punchAmt, amount);
  }

  private applyPunch(dt: number): void {
    if (this.punchAmt <= 0 && this.camera.fov === this.baseFov) return;
    this.punchAmt = this.punchAmt < 0.005 ? 0 : this.punchAmt * Math.exp(-7 * dt);
    this.camera.fov = this.baseFov * (1 - this.punchAmt * 0.09);
    this.camera.updateProjectionMatrix();
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

  /**
   * @param targetX x position to follow (usually the ball or your player)
   * @param side which end to watch from: 1 = behind the near baseline, -1 = the far one (online guests)
   */
  update(dt: number, targetX: number, side: 1 | -1 = 1): void {
    const f = this.framing;
    const k = dt > 0 ? 1 - Math.exp(-2.5 * dt) : 1;
    // Portrait screens are narrow: keep the court centered instead of sliding with the player.
    const follow = this.aspect < 0.8 ? 0.08 : 0.3;
    this.focusX += (targetX * follow - this.focusX) * k;
    this.camera.position.set(this.focusX, f.height, side * f.back);
    this.camera.lookAt(this.focusX * 0.5, 0, side * f.lookZ);
    this.applyShake(dt);
    this.applyPunch(dt);
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
    this.baseFov = aspect < 1.3 ? Math.min(aspect < 0.8 ? 80 : 75, base * (1.3 / aspect) ** 0.85) : base;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }
}
