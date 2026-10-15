import { Vector3 } from 'three';
import { COURT, netHeightAt } from '../game/court';
import { PHYS } from './constants';

export type BallEventType = 'bounce' | 'net' | 'netcord';

export interface BallEvent {
  type: BallEventType;
  x: number;
  y: number;
  z: number;
  /** Impact speed (ft/s). */
  speed: number;
}

export interface FlightState {
  pos: Vector3;
  vel: Vector3;
  /** Angular velocity (rad/s). */
  spin: Vector3;
}

const magnusAccel = new Vector3();

/** Advances a ball in free flight: gravity, quadratic drag and Magnus force. */
export function integrateFlight(s: FlightState, dt: number): void {
  const v = s.vel;
  const dragK = PHYS.drag * v.length();
  magnusAccel.crossVectors(s.spin, v).multiplyScalar(PHYS.magnus);
  v.x += (magnusAccel.x - dragK * v.x) * dt;
  v.y += (magnusAccel.y - dragK * v.y - PHYS.gravity) * dt;
  v.z += (magnusAccel.z - dragK * v.z) * dt;
  s.pos.addScaledVector(v, dt);
  s.spin.multiplyScalar(1 - PHYS.spinDecay * dt);
}

/** The match ball: flight, bounces off the court, and net collisions. */
export class Ball implements FlightState {
  readonly pos = new Vector3(0, PHYS.ballRadius, 0);
  readonly vel = new Vector3();
  readonly spin = new Vector3();
  /** False when the ball is held (serve) or has come to rest. */
  inPlay = false;
  rolling = false;
  private events: BallEvent[] = [];

  launch(pos: Vector3, vel: Vector3, spin: Vector3): void {
    this.pos.copy(pos);
    this.vel.copy(vel);
    this.spin.copy(spin);
    this.inPlay = true;
    this.rolling = false;
  }

  /** Freezes the ball at a position (e.g. in the server's hand). */
  hold(pos: Vector3): void {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.inPlay = false;
    this.rolling = false;
  }

  /** Events since the last call (bounces, net hits). */
  drainEvents(): BallEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  step(dt: number): void {
    if (!this.inPlay) return;
    const px = this.pos.x;
    const py = this.pos.y;
    const pz = this.pos.z;
    if (this.rolling) this.roll(dt);
    else integrateFlight(this, dt);
    this.collideNet(px, py, pz);
    this.collideGround();
  }

  private roll(dt: number): void {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const drop = PHYS.rollFriction * dt;
    if (speed <= drop) {
      this.vel.set(0, 0, 0);
      this.spin.set(0, 0, 0);
      this.inPlay = false;
      return;
    }
    const k = (speed - drop) / speed;
    this.vel.x *= k;
    this.vel.z *= k;
    this.vel.y = 0;
    this.pos.addScaledVector(this.vel, dt);
    // keep the visual spin matched to rolling without slipping
    const r = PHYS.ballRadius;
    this.spin.set(this.vel.z / r, 0, -this.vel.x / r);
  }

  private collideNet(px: number, py: number, pz: number): void {
    const z1 = this.pos.z;
    if (Math.sign(pz) === Math.sign(z1) && z1 !== 0) return;
    if (pz === z1) return;
    const t = pz / (pz - z1);
    const x = px + (this.pos.x - px) * t;
    const r = PHYS.ballRadius;
    if (Math.abs(x) > COURT.netPostX + r) return; // went around the post
    const y = py + (this.pos.y - py) * t;
    const h = netHeightAt(x);
    const speed = this.vel.length();
    const side = Math.sign(pz) || 1;

    if (y < h - r * 0.25) {
      // Into the net: it soaks up nearly all the speed and the ball drops on the hitter's side.
      this.pos.set(x, y, side * r);
      this.vel.z = -this.vel.z * PHYS.netDamping;
      this.vel.x *= 0.35;
      this.vel.y = Math.min(this.vel.y, 0) * 0.3;
      this.spin.multiplyScalar(0.2);
      this.events.push({ type: 'net', x, y, z: 0, speed });
    } else if (y < h + r) {
      // Clipped the tape: pops up and trickles over.
      this.vel.z *= 0.55;
      this.vel.x *= 0.8;
      this.vel.y = Math.abs(this.vel.y) * 0.35 + 3.5;
      this.spin.multiplyScalar(0.3);
      this.events.push({ type: 'netcord', x, y, z: 0, speed });
    }
  }

  private collideGround(): void {
    const r = PHYS.ballRadius;
    if (this.pos.y > r) return;
    this.pos.y = r;
    if (this.rolling || this.vel.y >= 0) return;

    const vn = -this.vel.y;
    const e = Math.max(PHYS.minRestitution, PHYS.restitution - PHYS.restitutionSpeedLoss * vn);

    // Friction impulse at the contact point (hollow sphere, I = 2/3 m r²).
    // Contact-point velocity = v + ω × (0, -r, 0).
    const slipX = this.vel.x + r * this.spin.z;
    const slipZ = this.vel.z - r * this.spin.x;
    const slip = Math.hypot(slipX, slipZ);
    if (slip > 1e-6) {
      const j = Math.min(PHYS.friction * (1 + e) * vn, slip / 2.5);
      const jx = (-slipX / slip) * j;
      const jz = (-slipZ / slip) * j;
      this.vel.x += jx;
      this.vel.z += jz;
      this.spin.x += (-1.5 * jz) / r;
      this.spin.z += (1.5 * jx) / r;
    }

    this.vel.y = vn * e;
    if (this.vel.y < PHYS.rollThreshold) {
      this.vel.y = 0;
      this.rolling = true;
    }
    if (vn > 0.8) this.events.push({ type: 'bounce', x: this.pos.x, y: 0, z: this.pos.z, speed: vn });
  }
}
