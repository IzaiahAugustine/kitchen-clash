import type * as THREE from 'three';
import type { Controls } from '../input/controls';
import type { Keyboard } from '../input/keyboard';
import type { Sound } from '../audio/sound';
import type { Ball, BallEvent } from '../physics/ball';
import type { BallView } from '../render/ballView';
import type { Crowd } from '../render/crowd';
import type { Hud } from '../ui/hud';

/** Shared pieces every game mode works with. */
export interface World {
  scene: THREE.Scene;
  ball: Ball;
  ballView: BallView;
  hud: Hud;
  keys: Keyboard;
  controls: Controls;
  /** Missing in headless simulations. */
  audio?: Sound;
  crowd?: Crowd;
}

/** A way of playing (Ball Lab, practice, a match...). The Game drives it each frame. */
export interface GameMode {
  /** Fixed-rate simulation step, run just before the ball steps. */
  fixedUpdate(dt: number, time: number): void;
  onBallEvent(e: BallEvent, time: number): void;
  /** Once per rendered frame (dt is slow-mo aware and 0 while paused). */
  update(dt: number, time: number): void;
  /** HTML for the info panel. */
  describe(): string;
  /** x position the camera should drift toward. */
  cameraTargetX(): number;
  /** Remove everything this mode added to the scene. */
  dispose?(): void;
}
