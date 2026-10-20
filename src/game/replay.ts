import * as THREE from 'three';
import type { Ball } from '../physics/ball';

/** Seconds of play kept for replays. */
const KEEP = 7;
/** Floats stored per object: position xyz + quaternion xyzw. */
const STRIDE = 7;

interface Frame {
  t: number;
  /** Ball position, velocity, spin. */
  ball: Float32Array;
  nodes: Float32Array;
}

/** The ball as the ball view needs it to draw (and leave a trail). */
export interface ReplayBall {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  inPlay: boolean;
}

/**
 * Instant replay: keeps the last few seconds of the ball and every player joint, then plays a
 * stretch of it back (slow motion) and puts everything back where it was.
 */
export class Replay {
  private nodes: THREE.Object3D[] = [];
  private frames: Frame[] = [];
  private events: { t: number; fire: () => void }[] = [];
  private live: Float32Array | null = null;
  private clock = 0;
  private end = 0;
  private next = 0;
  private ball: ReplayBall = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), inPlay: true };
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();

  get playing(): boolean {
    return this.live !== null;
  }

  /** What to record (the players' moving parts). Starts a fresh recording. */
  track(nodes: THREE.Object3D[]): void {
    this.stop();
    this.nodes = nodes;
    this.frames = [];
    this.events = [];
  }

  /** Call once per frame of play, after everything has moved. */
  record(t: number, ball: Ball): void {
    if (this.playing || !this.nodes.length) return;
    const last = this.frames[this.frames.length - 1];
    if (last && t <= last.t) return;
    // Reuse the oldest frame's arrays once the buffer is full.
    const old = this.frames.length && this.frames[0].t < t - KEEP ? this.frames.shift()! : null;
    const f: Frame = old ?? { t, ball: new Float32Array(9), nodes: new Float32Array(this.nodes.length * STRIDE) };
    f.t = t;
    f.ball.set([ball.pos.x, ball.pos.y, ball.pos.z, ball.vel.x, ball.vel.y, ball.vel.z, ball.spin.x, ball.spin.y, ball.spin.z]);
    this.write(f.nodes);
    this.frames.push(f);
    while (this.events.length && this.events[0].t < t - KEEP) this.events.shift();
  }

  /** Something to repeat during the replay at game time `t` (a hit's sound and flash). */
  event(t: number, fire: () => void): void {
    if (!this.playing) this.events.push({ t, fire });
  }

  /** Play back game time from..to. Returns false if there's nothing recorded for it. */
  start(from: number, to: number): boolean {
    if (this.frames.length < 10) return false;
    this.clock = Math.max(from, this.frames[0].t);
    this.end = Math.min(to, this.frames[this.frames.length - 1].t);
    if (this.end - this.clock < 0.5) return false;
    this.live = new Float32Array(this.nodes.length * STRIDE);
    this.write(this.live);
    this.next = this.events.findIndex((e) => e.t >= this.clock);
    if (this.next < 0) this.next = this.events.length;
    return true;
  }

  /**
   * Advance the replay by `dt` of replay time. Poses the players and returns the ball to draw,
   * or null when it's over (everything is back to live).
   */
  step(dt: number): ReplayBall | null {
    if (!this.live) return null;
    this.clock += dt;
    if (this.clock >= this.end) {
      this.stop();
      return null;
    }
    while (this.next < this.events.length && this.events[this.next].t <= this.clock) this.events[this.next++].fire();
    // Frames either side of the clock, blended.
    let i = this.frames.findIndex((f) => f.t > this.clock);
    if (i <= 0) i = Math.max(1, this.frames.length - 1);
    const a = this.frames[i - 1];
    const b = this.frames[i];
    const k = Math.min(1, Math.max(0, (this.clock - a.t) / Math.max(1e-6, b.t - a.t)));
    const lerp = (x: number, y: number) => x + (y - x) * k;
    const bl = this.ball;
    bl.pos.set(lerp(a.ball[0], b.ball[0]), lerp(a.ball[1], b.ball[1]), lerp(a.ball[2], b.ball[2]));
    bl.vel.set(lerp(a.ball[3], b.ball[3]), lerp(a.ball[4], b.ball[4]), lerp(a.ball[5], b.ball[5]));
    bl.spin.set(lerp(a.ball[6], b.ball[6]), lerp(a.ball[7], b.ball[7]), lerp(a.ball[8], b.ball[8]));
    this.nodes.forEach((n, j) => {
      const o = j * STRIDE;
      const A = a.nodes;
      const B = b.nodes;
      n.position.set(lerp(A[o], B[o]), lerp(A[o + 1], B[o + 1]), lerp(A[o + 2], B[o + 2]));
      this.qa.set(A[o + 3], A[o + 4], A[o + 5], A[o + 6]);
      this.qb.set(B[o + 3], B[o + 4], B[o + 5], B[o + 6]);
      n.quaternion.slerpQuaternions(this.qa, this.qb, k);
    });
    return bl;
  }

  /** End the replay early (or on time): everything goes back to how it was. */
  stop(): void {
    if (!this.live) return;
    this.read(this.live);
    this.live = null;
  }

  private write(out: Float32Array): void {
    this.nodes.forEach((n, j) => {
      const o = j * STRIDE;
      out[o] = n.position.x;
      out[o + 1] = n.position.y;
      out[o + 2] = n.position.z;
      out[o + 3] = n.quaternion.x;
      out[o + 4] = n.quaternion.y;
      out[o + 5] = n.quaternion.z;
      out[o + 6] = n.quaternion.w;
    });
  }

  private read(src: Float32Array): void {
    this.nodes.forEach((n, j) => {
      const o = j * STRIDE;
      n.position.set(src[o], src[o + 1], src[o + 2]);
      n.quaternion.set(src[o + 3], src[o + 4], src[o + 5], src[o + 6]);
    });
  }
}
