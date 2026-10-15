import type * as THREE from 'three';
import type { Controls } from '../input/controls';
import type { Keyboard } from '../input/keyboard';
import type { Sound } from '../audio/sound';
import type { Ball, BallEvent } from '../physics/ball';
import type { BallView } from '../render/ballView';
import type { Crowd } from '../render/crowd';
import type { Hud } from '../ui/hud';

/** Visual juice the game provides to modes (absent in headless simulations). */
export interface Fx {
  /** Pop of light at a hit; `perfect` makes it big and gold. */
  burst(at: THREE.Vector3, power: number, perfect: boolean): void;
  /** Marker where the incoming ball will bounce (null hides it). */
  setLanding(p: THREE.Vector3 | null): void;
  /** Highlight of the service box to serve into (null hides it). */
  setServeBox(box: { x0: number; x1: number; z0: number; z1: number } | null): void;
  /** Camera shake (0..1). */
  shake(amount: number): void;
  /** Freeze the action for a moment (seconds) to sell a big hit. */
  hitstop(seconds: number): void;
}

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
  fx?: Fx;
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
  /** Which end of the court the camera sits behind (1 = near, the default; -1 = far). */
  cameraSide?(): 1 | -1;
  /** Online modes keep running while a menu is open (you can't pause your friend). */
  readonly online?: boolean;
}
