import { Vector3 } from 'three';
import { netHeightAt } from '../game/court';
import { integrateFlight } from './ball';
import { PHYS } from './constants';

export interface Landing {
  x: number;
  z: number;
  /** Seconds until the first bounce. */
  time: number;
  /** Gap between the bottom of the ball and the top of the net where it crosses (ft), or null if it never crosses. */
  netClearance: number | null;
}

/** Simulates free flight (no net collision) until the first bounce. */
export function simulateToLanding(pos: Vector3, vel: Vector3, spin: Vector3, maxTime = 6): Landing | null {
  const s = { pos: pos.clone(), vel: vel.clone(), spin: spin.clone() };
  const dt = PHYS.fixedDt * 2;
  let clearance: number | null = null;
  for (let t = 0; t < maxTime; t += dt) {
    const px = s.pos.x;
    const py = s.pos.y;
    const pz = s.pos.z;
    integrateFlight(s, dt);
    if (clearance === null && Math.sign(pz) !== Math.sign(s.pos.z)) {
      const f = pz / (pz - s.pos.z);
      const x = px + (s.pos.x - px) * f;
      const y = py + (s.pos.y - py) * f;
      clearance = y - PHYS.ballRadius - netHeightAt(x);
    }
    if (s.pos.y <= PHYS.ballRadius && s.vel.y < 0) {
      return { x: s.pos.x, z: s.pos.z, time: t + dt, netClearance: clearance };
    }
  }
  return null;
}

/** Launch velocity that lands on `to` after `time` seconds, ignoring drag and spin. */
export function ballisticVelocity(from: Vector3, to: Vector3, time: number): Vector3 {
  return new Vector3(
    (to.x - from.x) / time,
    (PHYS.ballRadius - from.y + 0.5 * PHYS.gravity * time * time) / time,
    (to.z - from.z) / time,
  );
}

export interface ShotRequest {
  from: Vector3;
  /** Desired first-bounce point (y is ignored). */
  target: Vector3;
  /** Rough flight time: small = flat and fast, large = high and loopy. */
  flightTime: number;
  spin?: Vector3;
  /** If set, the arc is raised until the ball clears the net by at least this much (ft). */
  minNetClearance?: number;
}

export interface ShotSolution {
  velocity: Vector3;
  flightTime: number;
  landing: Landing | null;
}

const NO_SPIN = new Vector3();

/** Finds a launch velocity that lands on the target with full drag + spin physics. */
export function solveShot(req: ShotRequest): ShotSolution {
  const spin = req.spin ?? NO_SPIN;
  const crossesNet = Math.sign(req.from.z) !== Math.sign(req.target.z);
  let time = req.flightTime;
  let sol = aimFor(req.from, req.target, time, spin);
  if (req.minNetClearance === undefined || !crossesNet) return sol;
  for (let i = 0; i < 14; i++) {
    const c = sol.landing?.netClearance ?? Infinity;
    if (c >= req.minNetClearance) break;
    time *= 1.08;
    sol = aimFor(req.from, req.target, time, spin);
  }
  return sol;
}

/** Shooting method: fire, see where it landed, shift the aim point by the miss, repeat. */
function aimFor(from: Vector3, target: Vector3, time: number, spin: Vector3): ShotSolution {
  const aim = new Vector3(target.x, 0, target.z);
  let velocity = ballisticVelocity(from, aim, time);
  let landing = simulateToLanding(from, velocity, spin);
  for (let i = 0; i < 10 && landing; i++) {
    const ex = target.x - landing.x;
    const ez = target.z - landing.z;
    if (ex * ex + ez * ez < 0.0025) break;
    aim.x += ex;
    aim.z += ez;
    velocity = ballisticVelocity(from, aim, time);
    landing = simulateToLanding(from, velocity, spin);
  }
  return { velocity, flightTime: time, landing };
}

/** Topspin around the axis perpendicular to a horizontal travel direction (negative = backspin). */
export function topspin(direction: Vector3, radPerSec: number): Vector3 {
  const flat = new Vector3(direction.x, 0, direction.z).normalize();
  return new Vector3(0, 1, 0).cross(flat).multiplyScalar(radPerSec);
}
