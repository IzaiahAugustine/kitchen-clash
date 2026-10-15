import { Vector3 } from 'three';
import { COURT, type Side } from '../game/court';
import { topspin } from '../physics/trajectory';
import type { Hand } from './body';

export type ShotKind = 'drive' | 'smash' | 'dink' | 'drop' | 'reset' | 'lob' | 'serve' | 'speedup' | 'roll' | 'slice';
/** The three hit buttons: Drive (J), Soft (K) and Spin (L). */
export type ShotButton = 'drive' | 'soft' | 'spin';

export type Grade = 'perfect' | 'good' | 'early' | 'late';
export interface Timing {
  grade: Grade;
  /** Seconds away from the ideal press moment (0 = perfect). */
  error: number;
}

export const SHOT_NAMES: Record<ShotKind, string> = {
  drive: 'Drive',
  smash: 'Smash',
  dink: 'Dink',
  drop: 'Third-shot drop',
  reset: 'Reset',
  lob: 'Lob',
  serve: 'Serve',
  speedup: 'Speed-up',
  roll: 'Topspin roll',
  slice: 'Slice',
};

/**
 * Context shots: the same button does different things depending on where you are.
 *   Drive button: drive from the back, dink at the kitchen, smash a high ball at the kitchen.
 *   Soft button:  drop from the baseline, reset from midcourt, lob from the kitchen.
 *   Spin button:  topspin roll at the kitchen, slice from the back (tiny timing window).
 */
export function chooseShotKind(button: ShotButton, contact: Vector3): ShotKind {
  const fromNet = Math.abs(contact.z);
  const atKitchen = fromNet <= COURT.kitchenDepth + 3;
  if (button === 'spin') {
    // Spin, the skill shot: a dipping topspin roll at the kitchen, a low skidding slice from the back.
    return atKitchen ? 'roll' : 'slice';
  }
  if (button === 'drive') {
    // A high ball can be smashed from anywhere; at the kitchen even a chest-high one.
    if (!atKitchen) return contact.y >= 4.6 ? 'smash' : 'drive';
    return contact.y >= 3.4 ? 'smash' : 'dink';
  }
  if (atKitchen) return 'lob';
  return fromNet >= 15 ? 'drop' : 'reset';
}

interface ShotSpec {
  /** Landing distance past the net, [short, deep]. Aiming forward/back picks within it. */
  depth: [number, number];
  /** Rough flight time to the bounce (smaller = flatter and faster). */
  time: number;
  /** Topspin in rad/s (negative = backspin). */
  spin: number;
  /** Minimum net clearance (ft) the shot is shaped to have. */
  clearance: number;
  /** How far sideways a full left/right aim sends it. */
  width: number;
}

const SPECS: Record<ShotKind, ShotSpec> = {
  drive: { depth: [13, 19.5], time: 0.68, spin: 55, clearance: 0.2, width: 8 },
  smash: { depth: [9, 16], time: 0.34, spin: 30, clearance: 0.08, width: 8.5 },
  dink: { depth: [2.5, 6], time: 1.0, spin: -12, clearance: 0.15, width: 8 },
  drop: { depth: [3, 6.5], time: 1.55, spin: 15, clearance: 0.4, width: 7.5 },
  reset: { depth: [3.5, 6.5], time: 1.25, spin: 0, clearance: 0.3, width: 7.5 },
  lob: { depth: [17.5, 20.5], time: 2.2, spin: 30, clearance: 2.5, width: 7 },
  serve: { depth: [12, 19], time: 1.25, spin: 20, clearance: 1.0, width: 7 },
  speedup: { depth: [8, 15], time: 0.46, spin: 40, clearance: 0.06, width: 7.5 },
  // Heavy topspin dives down after the net, so it can be rolled off a low ball.
  roll: { depth: [6, 13], time: 0.6, spin: 150, clearance: 0.3, width: 8.5 },
  // Backspin: flat and low, and it checks up after the bounce.
  slice: { depth: [12, 19], time: 0.88, spin: -85, clearance: 0.22, width: 8 },
};

/** Aim from the stick while swinging: x = hitter's right, y = deeper. Each -1..1. */
export interface Aim {
  x: number;
  y: number;
}

export interface ShotPlan {
  target: Vector3;
  flightTime: number;
  spin: Vector3;
  /** Net clearance to guarantee; undefined lets a bad shot find the net. */
  clearance: number | undefined;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Net height (ft) the ball has to be above to attack it near the net. */
const ATTACK_HEIGHT = 2.7;
/** At the kitchen line: this close to the net (ft) and moving slower than SET_SPEED counts as "set". */
export const SET_ZONE = COURT.kitchenDepth + 3;
export const SET_SPEED = 3;
/** Within this distance of the net, low balls can't be attacked. */
const ATTACK_ZONE = 12;

/**
 * Rolling a ball below net height near the net only works with Perfect timing; anything less
 * and it pops up (easy to smash back). 0 = fine, 1 = hopeless.
 */
export function lowAttackPenalty(kind: ShotKind, from: Vector3, timing: Timing): number {
  if (kind !== 'roll' || timing.grade === 'perfect' || Math.abs(from.z) > ATTACK_ZONE || from.y >= ATTACK_HEIGHT) return 0;
  return Math.min(1, Math.max(0.5, (ATTACK_HEIGHT - from.y) / 1.6));
}

/**
 * Spin shots get harder to time each time you use one in a row (so they can't be spammed):
 * the windows shrink, and a hit that misses the smaller window counts as early or late.
 */
export function spinStreakTiming(t: Timing, streak: number): Timing {
  if (streak <= 0 || (t.grade !== 'perfect' && t.grade !== 'good')) return t;
  const f = 1 / (1 + 0.45 * streak);
  if (t.error <= SPIN_WINDOWS.perfect * f) return t;
  if (t.error <= SPIN_WINDOWS.good * f) return { grade: 'good', error: t.error };
  return { grade: Math.random() < 0.5 ? 'early' : 'late', error: Math.max(t.error, 0.13) };
}

/** Timing windows (seconds either side of ideal) for spin shots: the tightest in the game. */
export const SPIN_WINDOWS = { perfect: 0.03, good: 0.075 };

/** Turns a shot kind + aim + timing into a landing target and shape. */
export function planShot(
  kind: ShotKind,
  from: Vector3,
  hitterSide: Side,
  hand: Hand,
  aim: Aim,
  timing: Timing,
  /** Hit with the Spin button: tight timing, and mistimed spin shots go badly wrong. */
  spun = false,
  /**
   * How fast the ball was coming (ft/s), how fast the hitter was moving (ft/s) and how much of
   * that was toward the net, and whether it's a volley.
   */
  situation: { incomingSpeed?: number; hitterSpeed?: number; towardNet?: number; volley?: boolean } = {},
): ShotPlan {
  const spec = SPECS[kind];
  // The hitter's right is +x on the near side and -x on the far side.
  const right = hitterSide;
  let depth = spec.depth[0] + (spec.depth[1] - spec.depth[0]) * (0.5 + 0.5 * aim.y);
  let lateral = Math.abs(aim.x) >= 0.2 ? aim.x * spec.width : right * (from.x * 0.35) + rand(-1.5, 1.5);
  let time = spec.time;
  let scatter = 1;
  let clearance: number | undefined = spec.clearance;

  const power = kind === 'drive' || kind === 'smash' || kind === 'speedup' || kind === 'roll';
  let spinRate = spec.spin;
  const low = lowAttackPenalty(kind, from, timing);
  if (timing.grade === 'perfect') {
    scatter = 0.35;
    if (power) time *= 0.9;
  } else if (timing.grade === 'good' && spun) {
    // Spin without perfect timing barely bites, and it's loose: sometimes long or wide.
    spinRate *= 0.5;
    scatter = 1.8;
    if (Math.random() < 0.5) {
      lateral += (Math.random() < 0.5 ? -1 : 1) * rand(4, 6.5);
      depth += rand(4, 7);
    }
  } else if (timing.grade === 'early' || timing.grade === 'late') {
    // A mistimed shot goes wrong one of three ways, more likely the worse the timing.
    const bad = Math.min(1, (timing.error - 0.12) / 0.2);
    const roll = Math.random();
    const soft = (!power && kind !== 'lob') || spun;
    if (spun) spinRate *= 0.3;
    if (roll < 0.25 + 0.2 * bad + (spun ? 0.2 : 0)) {
      // Dumped: hit low and flat, it may find the net.
      time *= 0.72;
      clearance = undefined;
    } else if (soft && roll < 0.55 + 0.15 * bad) {
      // Popped up: a soft shot that floats high, begging to be smashed.
      time *= 1.45;
      depth -= 1;
      clearance = 2.5;
    } else {
      // Sprayed: early pulls across your body, late pushes the other way, with less pace.
      const miss = (2.5 + Math.max(0, timing.error - 0.12) * 30) * (spun ? 1.6 : 1);
      const dir = (timing.grade === 'early' ? -1 : 1) * (hand === 'fore' ? 1 : -1);
      lateral += dir * miss;
      depth += rand(-2.5, 2.5);
      if (power) time *= 1.15;
      clearance = spec.clearance * 0.3;
    }
    scatter = 1.5;
  }

  // Real-life control: a blistering ball is hard to swing at (blocking it softly is fine),
  // and hitting on the run is less accurate than being set.
  const pressure = Math.min(1, Math.max(0, ((situation.incomingSpeed ?? 0) - 45) / 30));
  const onTheRun = Math.min(1, Math.max(0, ((situation.hitterSpeed ?? 0) - 5) / 8));
  const hardSwing = power || kind === 'lob' || spun;
  // Brushing the ball for spin while sprinting is especially hard.
  scatter += pressure * (hardSwing ? 1.6 : 0.4) + onTheRun * (spun ? 2.4 : 1.1);
  if (pressure > 0.5 && hardSwing && timing.grade !== 'perfect' && Math.random() < 0.3 * pressure) {
    // Rushed: the swing is late on the pace and the ball flies long or wide.
    lateral += (Math.random() < 0.5 ? -1 : 1) * rand(2, 4);
    depth += rand(1, 4);
  }

  // Owning the net: planted at the kitchen line, volleys and dinks are crisper, and volleys
  // can be punched harder and at sharper angles.
  const fromNet = Math.abs(from.z);
  const set = fromNet <= SET_ZONE && (situation.hitterSpeed ?? 0) < SET_SPEED;
  if (set && kind !== 'lob') {
    scatter *= 0.7;
    if (situation.volley && kind !== 'dink' && kind !== 'reset') {
      time *= 0.93;
      lateral *= 1.12;
    }
  }
  // No man's land: charging through midcourt with the ball at your feet is hard to handle.
  const charging = (situation.towardNet ?? 0) > 4;
  if (charging && fromNet > SET_ZONE && fromNet < 17 && from.y < 1.6 && timing.grade !== 'perfect') {
    scatter += 1.4;
    const r = Math.random();
    if (r < 0.25) {
      clearance = undefined; // dumped into the net
      time *= 0.8;
    } else if (r < 0.55) {
      clearance = 2.2; // popped up
      time *= 1.4;
      depth -= 1;
    }
  }

  if (low > 0) {
    // A mistimed roll off a low ball: often straight into the net, otherwise it floats up
    // slow and high for the other side to smash.
    if (Math.random() < 0.3 + 0.25 * low) {
      time *= 0.7;
      clearance = undefined;
      depth = Math.min(depth, 4);
    } else {
      time *= 1 + 0.9 * low;
      clearance = 0.8 + 2 * low;
      depth += rand(0, 5) * low;
    }
    scatter = Math.max(scatter, 1.5);
  }

  const target = new Vector3(
    right * lateral + rand(-1, 1) * scatter,
    0,
    -hitterSide * (depth + rand(-1, 1) * scatter),
  );
  return {
    target,
    flightTime: time,
    spin: topspin(target.clone().sub(from), spinRate),
    clearance,
  };
}
