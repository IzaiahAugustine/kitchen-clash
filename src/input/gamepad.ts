/** Standard-mapping gamepad buttons. */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  START: 9,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

const DEADZONE = 0.2;

/** Polls the first connected gamepad once per frame and tracks button presses. */
export class GamepadInput {
  connected = false;
  name = '';
  private cur: boolean[] = [];
  private prev: boolean[] = [];
  private axes: [number, number] = [0, 0];

  poll(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p): p is Gamepad => !!p && p.connected);
    this.prev = this.cur;
    if (!gp) {
      this.connected = false;
      this.cur = [];
      this.axes = [0, 0];
      return;
    }
    this.connected = true;
    this.name = gp.id;
    this.cur = gp.buttons.map((b) => b.pressed);
    this.axes = [gp.axes[0] ?? 0, gp.axes[1] ?? 0];
  }

  held(button: number): boolean {
    return !!this.cur[button];
  }

  pressed(button: number): boolean {
    return !!this.cur[button] && !this.prev[button];
  }

  /** Left stick (or d-pad) with a radial deadzone. y is positive when pushed up. */
  stick(): { x: number; y: number } {
    let x = this.axes[0];
    let y = -this.axes[1];
    const m = Math.hypot(x, y);
    if (m < DEADZONE) {
      x = 0;
      y = 0;
    } else {
      const k = Math.min(1, (m - DEADZONE) / (1 - DEADZONE)) / m;
      x *= k;
      y *= k;
    }
    if (this.held(PAD.LEFT)) x = -1;
    if (this.held(PAD.RIGHT)) x = 1;
    if (this.held(PAD.UP)) y = 1;
    if (this.held(PAD.DOWN)) y = -1;
    return { x, y };
  }
}
