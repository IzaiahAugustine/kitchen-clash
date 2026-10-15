import * as THREE from 'three';

/**
 * Classic arcade-tennis camera: high up behind the near baseline, looking down the court.
 * Drifts sideways a little to follow the action.
 */
export class ArcadeCamera {
  readonly camera: THREE.PerspectiveCamera;
  private focusX = 0;

  static readonly HEIGHT = 24;
  static readonly BACK_Z = 52;
  static readonly LOOK_Z = 4;
  static readonly BASE_FOV = 38;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(ArcadeCamera.BASE_FOV, aspect, 0.5, 600);
    this.resize(aspect);
    this.update(0, 0);
  }

  /** @param targetX x position to follow (usually the ball or the human player). */
  update(dt: number, targetX: number): void {
    const k = dt > 0 ? 1 - Math.exp(-2.5 * dt) : 1;
    this.focusX += (targetX * 0.3 - this.focusX) * k;
    this.camera.position.set(this.focusX, ArcadeCamera.HEIGHT, ArcadeCamera.BACK_Z);
    this.camera.lookAt(this.focusX * 0.5, 0, ArcadeCamera.LOOK_Z);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    // Narrow / portrait screens widen the view so both sidelines stay visible.
    this.camera.fov = aspect < 1.3 ? Math.min(75, ArcadeCamera.BASE_FOV * (1.3 / aspect) ** 0.85) : ArcadeCamera.BASE_FOV;
    this.camera.updateProjectionMatrix();
  }
}
