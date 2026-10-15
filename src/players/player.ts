import { Vector3 } from 'three';
import type { Side } from '../game/court';
import type { Hand } from './body';
import type { Palette } from './palette';
import type { ShotButton, ShotKind, Timing } from './shots';
import type { SwingPoses } from './swingPoses';

/** A planned ball contact: when and where the paddle will meet the ball. */
export interface Contact {
  /** Seconds from when it was planned. */
  t: number;
  pos: Vector3;
  hand: Hand;
  /** Where the player's feet need to be at contact. */
  standAt: Vector3;
  crouch: number;
  /** Ball flight this contact was planned against (see Ball.flight). */
  flight: number;
  /** True if the ball will have bounced (groundstroke), false for a volley. */
  bounced: boolean;
}

export interface Swing {
  button: ShotButton;
  kind: ShotKind | 'whiff';
  hand: Hand;
  startAt: number;
  contactAt: number;
  endAt: number;
  /** Null for a whiff. */
  contact: Contact | null;
  timing: Timing | null;
  poses: SwingPoses;
  resolved: boolean;
  /** Shown to the player when the swing starts (e.g. "Too early!"). */
  note?: string;
  /** Practice feed / serve: hits a held ball, not one in flight. */
  feed?: boolean;
}

const ACCEL = 90;
const MAGNET_MAX_SPEED = 22;
export const RECOVER_TIME = 0.25;

export class Player {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  /** Desired velocity, set by the controller (human input or AI). */
  readonly intent = new Vector3();
  /** Unit vector toward the net. */
  readonly forward: Vector3;
  /** Unit vector to the player's right. */
  readonly right: Vector3;
  readonly yaw: number;
  maxSpeed = 15;
  swing: Swing | null = null;

  constructor(
    readonly name: string,
    readonly side: Side,
    readonly palette: Palette,
  ) {
    this.forward = new Vector3(0, 0, -side);
    this.right = new Vector3(side, 0, 0);
    this.yaw = side === 1 ? 0 : Math.PI;
  }

  canSwing(time: number): boolean {
    return !this.swing || time >= this.swing.endAt;
  }

  step(dt: number, time: number): void {
    const sw = this.swing;
    if (sw && time > sw.endAt + RECOVER_TIME) this.swing = null;

    if (sw && sw.contact && !sw.resolved) {
      // Committed to a shot: glide into the hitting position so the paddle meets the ball.
      const remain = Math.max(sw.contactAt - time, dt);
      let vx = (sw.contact.standAt.x - this.pos.x) / remain;
      let vz = (sw.contact.standAt.z - this.pos.z) / remain;
      const m = Math.hypot(vx, vz);
      if (m > MAGNET_MAX_SPEED) {
        vx *= MAGNET_MAX_SPEED / m;
        vz *= MAGNET_MAX_SPEED / m;
      }
      this.vel.set(vx, 0, vz);
    } else {
      const slow = sw ? 0.35 : 1;
      let tx = this.intent.x * slow;
      let tz = this.intent.z * slow;
      const tm = Math.hypot(tx, tz);
      const max = this.maxSpeed * slow;
      if (tm > max) {
        tx *= max / tm;
        tz *= max / tm;
      }
      let dx = tx - this.vel.x;
      let dz = tz - this.vel.z;
      const dm = Math.hypot(dx, dz);
      const maxDv = ACCEL * dt;
      if (dm > maxDv) {
        dx *= maxDv / dm;
        dz *= maxDv / dm;
      }
      this.vel.x += dx;
      this.vel.z += dz;
    }

    this.pos.addScaledVector(this.vel, dt);
    // Stay on your own side of the net and inside the fence.
    const minZ = 0.8;
    const maxZ = 30;
    const along = this.side * this.pos.z;
    if (along < minZ || along > maxZ) {
      this.pos.z = this.side * Math.min(maxZ, Math.max(minZ, along));
      this.vel.z = 0;
    }
    if (Math.abs(this.pos.x) > 15.5) {
      this.pos.x = Math.sign(this.pos.x) * 15.5;
      this.vel.x = 0;
    }
  }
}
