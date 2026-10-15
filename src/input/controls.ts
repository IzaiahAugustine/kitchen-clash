import { GamepadInput, PAD } from './gamepad';
import type { Keyboard } from './keyboard';
import type { TouchControls } from './touch';

/** One frame of player input, merged from keyboard, gamepad and touch. */
export interface ControlFrame {
  /** Movement / aim, -1..1. x = right, y = up (toward the net). */
  moveX: number;
  moveY: number;
  /** Shot button 1 (Drive) pressed this frame. */
  drive: boolean;
  /** Shot button 2 (Soft / Lob) pressed this frame. */
  soft: boolean;
  /** Shot button 3 (Power) pressed this frame. */
  power: boolean;
  feed: boolean;
  pause: boolean;
}

const KEYS = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  // Shot buttons sit side by side: J + K for the right hand while the left uses WASD,
  // or Z + X for the left hand when steering with the arrow keys.
  drive: ['KeyJ', 'KeyZ'],
  soft: ['KeyK', 'KeyX'],
  // Power sits right next to them: L with J/K, or C with Z/X.
  power: ['KeyL', 'KeyC'],
  feed: ['Enter'],
  pause: ['KeyP', 'Escape'],
};

export class Controls {
  readonly pad = new GamepadInput();
  frame: ControlFrame = { moveX: 0, moveY: 0, drive: false, soft: false, power: false, feed: false, pause: false };

  /** On-screen phone controls, when present. */
  touch: TouchControls | null = null;

  constructor(private keys: Keyboard) {}

  /** Call once at the start of each rendered frame. */
  update(): ControlFrame {
    this.pad.poll();
    const k = this.keys;
    const held = (codes: string[]) => codes.some((c) => k.isDown(c));
    const pressed = (codes: string[]) => codes.some((c) => k.wasPressed(c));

    let x = (held(KEYS.right) ? 1 : 0) - (held(KEYS.left) ? 1 : 0);
    let y = (held(KEYS.up) ? 1 : 0) - (held(KEYS.down) ? 1 : 0);
    if (x && y) {
      x *= Math.SQRT1_2;
      y *= Math.SQRT1_2;
    }
    for (const stick of [this.pad.stick(), this.touch?.stick() ?? { x: 0, y: 0 }]) {
      if (Math.hypot(stick.x, stick.y) > Math.hypot(x, y)) {
        x = stick.x;
        y = stick.y;
      }
    }
    const t = this.touch;

    const p = this.pad;
    this.frame = {
      moveX: x,
      moveY: y,
      drive: pressed(KEYS.drive) || p.pressed(PAD.A) || !!t?.take('drive'),
      soft: pressed(KEYS.soft) || p.pressed(PAD.X) || p.pressed(PAD.B) || !!t?.take('soft'),
      power: pressed(KEYS.power) || p.pressed(PAD.RB) || p.pressed(PAD.RT) || !!t?.take('power'),
      feed: pressed(KEYS.feed) || p.pressed(PAD.Y),
      pause: pressed(KEYS.pause) || p.pressed(PAD.START) || !!t?.take('pause'),
    };
    return this.frame;
  }
}
