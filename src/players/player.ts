import { Vector3 } from 'three';
import type { Side } from '../game/court';
import type { Hand } from './body';
import type { Palette } from './palette';
import type { ShotButton, ShotKind, ShotPlan, Timing } from './shots';
import { buildSwingPoses, styleFor, type SwingPoses } from './swingPoses';

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
  /** Pre-planned shot (serves), used instead of planning from aim + timing at contact. */
  plan?: ShotPlan;
  /**
   * Online rewind: a friend's hit that reached us after the moment it happened. Hit the ball
   * from where it was then, and fast-forward it `ago` seconds.
   */
  rewind?: { pos: Vector3; vel: Vector3; spin: Vector3; rolling: boolean; bounces: number; ago: number };
}

/** Speeding up: a quick first step, but you can't hit top speed instantly. */
const ACCEL = 32;
/** Slowing down or changing direction: plant a foot and push off. */
const BRAKE = 55;
export const RECOVER_TIME = 0.25;
/** At contact the player can lunge/reach this far from the ideal hitting spot. */
export const LUNGE_REACH = 2.2;
/** Farther than the lunge still gets a weak, stretched shot up to here; beyond it's a miss. */
export const STRETCH_REACH = 3.6;

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
  /** Top sprint speed (ft/s). Side-shuffling and backpedaling are slower (see speedFactor). */
  maxSpeed = 14;
  swing: Swing | null = null;
  /** Game time of the last split step (a little hop as the opponent hits). */
  splitStepAt = -1;
  /** Wall-clock ms (performance.now) when this player started celebrating a win. */
  celebrateAt = -Infinity;

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

  /** Top-speed multiplier for moving in a direction: sprint forward 1, shuffle sideways 0.82, backpedal 0.62. */
  speedFactor(dx: number, dz: number): number {
    const m = Math.hypot(dx, dz);
    if (m < 1e-6) return 1;
    const f = (dx * this.forward.x + dz * this.forward.z) / m;
    return f >= 0 ? 0.82 + 0.18 * f : 0.82 - 0.2 * -f;
  }

  /** How far the player can run in `t` seconds in direction (dx, dz), starting from a standstill. */
  coverable(t: number, dx: number, dz: number): number {
    if (t <= 0) return 0;
    const v = this.maxSpeed * this.speedFactor(dx, dz);
    const tAccel = v / ACCEL;
    return t <= tAccel ? 0.5 * ACCEL * t * t : v * (t - tAccel / 2);
  }

  /** Distance from where the player is to where they need to be for the swing's contact. */
  contactGap(): number {
    const c = this.swing?.contact;
    return c ? Math.hypot(c.standAt.x - this.pos.x, c.standAt.z - this.pos.z) : 0;
  }

  step(dt: number, time: number): void {
    const sw = this.swing;
    if (sw && time > sw.endAt + RECOVER_TIME) this.swing = null;

    let tx: number;
    let tz: number;
    let slow = 1;
    if (sw && sw.contact && !sw.resolved) {
      // Committed to a shot: run to the hitting spot, timing the arrival for contact.
      const dx = sw.contact.standAt.x - this.pos.x;
      const dz = sw.contact.standAt.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const remain = Math.max(sw.contactAt - time, 0.05);
      const speed = d < 0.05 ? 0 : Math.max(d / remain, Math.min(d * 3, this.maxSpeed));
      tx = d < 0.05 ? 0 : (dx / d) * speed;
      tz = d < 0.05 ? 0 : (dz / d) * speed;
    } else {
      // Recovering from a follow-through slows you down.
      slow = sw ? 0.45 : 1;
      tx = this.intent.x * slow;
      tz = this.intent.z * slow;
    }

    const max = this.maxSpeed * this.speedFactor(tx, tz) * slow;
    const tm = Math.hypot(tx, tz);
    if (tm > max) {
      tx *= max / tm;
      tz *= max / tm;
    }
    // Accelerate gently, brake and cut hard.
    const vx = this.vel.x;
    const vz = this.vel.z;
    const speeding = tx * vx + tz * vz >= 0 && Math.hypot(tx, tz) >= Math.hypot(vx, vz);
    let dx = tx - vx;
    let dz = tz - vz;
    const dm = Math.hypot(dx, dz);
    const maxDv = (speeding ? ACCEL : BRAKE) * dt;
    if (dm > maxDv) {
      dx *= maxDv / dm;
      dz *= maxDv / dm;
    }
    this.vel.x += dx;
    this.vel.z += dz;

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

    // Re-aim the swing from where the player actually is, so the arm reaches for the real ball.
    if (sw && sw.contact && !sw.resolved) {
      const c = sw.contact.pos;
      const dx = c.x - this.pos.x;
      const dz = c.z - this.pos.z;
      const local = new Vector3(
        dx * this.right.x + dz * this.right.z,
        c.y,
        -(dx * this.forward.x + dz * this.forward.z),
      );
      sw.poses = buildSwingPoses(styleFor(sw.kind), sw.hand, local, sw.contact.crouch);
    }
  }
}
