import { GamepadInput, PAD } from './gamepad';
import type { Keyboard } from './keyboard';

/** One frame of player input, merged from keyboard and gamepad. */
export interface ControlFrame {
  /** Movement / aim, -1..1. x = right, y = up (toward the net). */
  moveX: number;
  moveY: number;
  /** Shot button 1 (Drive) pressed this frame. */
  drive: boolean;
  /** Shot button 2 (Soft / Lob) pressed this frame. */
  soft: boolean;
  feed: boolean;
  pause: boolean;
}

const KEYS = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  drive: ['KeyJ', 'KeyZ', 'Space'],
  soft: ['KeyK', 'KeyX'],
  feed: ['Enter'],
  pause: ['KeyP', 'Escape'],
};

export class Controls {
  readonly pad = new GamepadInput();
  frame: ControlFrame = { moveX: 0, moveY: 0, drive: false, soft: false, feed: false, pause: false };

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
    const stick = this.pad.stick();
    if (Math.hypot(stick.x, stick.y) > Math.hypot(x, y)) {
      x = stick.x;
      y = stick.y;
    }

    const p = this.pad;
    this.frame = {
      moveX: x,
      moveY: y,
      drive: pressed(KEYS.drive) || p.pressed(PAD.A),
      soft: pressed(KEYS.soft) || p.pressed(PAD.X) || p.pressed(PAD.B),
      feed: pressed(KEYS.feed) || p.pressed(PAD.Y),
      pause: pressed(KEYS.pause) || p.pressed(PAD.START),
    };
    return this.frame;
  }
}
