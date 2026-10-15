import { Vector3 } from 'three';
import { COURT, type Side } from '../game/court';
import { topspin } from '../physics/trajectory';
import type { Hand } from './body';

export type ShotKind = 'drive' | 'smash' | 'dink' | 'drop' | 'reset' | 'lob' | 'serve' | 'speedup' | 'blast';
/** The three hit buttons: Drive (J), Soft (K) and Power (L). */
export type ShotButton = 'drive' | 'soft' | 'power';

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
  blast: 'Power drive',
};

/**
 * Context shots: the same button does different things depending on where you are.
 *   Drive button: drive from the back, dink at the kitchen, smash a high ball at the kitchen.
 *   Soft button:  drop from the baseline, reset from midcourt, lob from the kitchen.
 */
export function chooseShotKind(button: ShotButton, contact: Vector3): ShotKind {
  const fromNet = Math.abs(contact.z);
  const atKitchen = fromNet <= COURT.kitchenDepth + 3;
  if (button === 'power') {
    // Power: a smash on a high ball, a speed-up at the kitchen, a blistering drive from the back.
    if (contact.y >= 3.4) return 'smash';
    return atKitchen ? 'speedup' : 'blast';
  }
  if (button === 'drive') {
    if (!atKitchen) return 'drive';
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
  blast: { depth: [14, 20], time: 0.54, spin: 75, clearance: 0.12, width: 8.5 },
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
/** Within this distance of the net, low balls can't be attacked. */
const ATTACK_ZONE = 12;

/**
 * Power off a ball below net height near the net can't be hit down: it has to go up to clear
 * the net, so it pops up (easy to smash back) or sails long. 0 = fine, 1 = hopeless.
 * This is why low dinks matter: they can't be attacked.
 */
export function lowAttackPenalty(kind: ShotKind, from: Vector3, powered: boolean): number {
  if (!powered || kind === 'smash' || Math.abs(from.z) > ATTACK_ZONE || from.y >= ATTACK_HEIGHT) return 0;
  return Math.min(1, Math.max(0.35, (ATTACK_HEIGHT - from.y) / 1.6));
}

/** Turns a shot kind + aim + timing into a landing target and shape. */
export function planShot(
  kind: ShotKind,
  from: Vector3,
  hitterSide: Side,
  hand: Hand,
  aim: Aim,
  timing: Timing,
  /** Hit with the Power button: faster, but mistimed power shots go badly wrong. */
  powered = false,
  /** How fast the ball was coming (ft/s) and how fast the hitter was moving (ft/s). */
  situation: { incomingSpeed?: number; hitterSpeed?: number } = {},
): ShotPlan {
  const spec = SPECS[kind];
  // The hitter's right is +x on the near side and -x on the far side.
  const right = hitterSide;
  let depth = spec.depth[0] + (spec.depth[1] - spec.depth[0]) * (0.5 + 0.5 * aim.y);
  let lateral = Math.abs(aim.x) >= 0.2 ? aim.x * spec.width : right * (from.x * 0.35) + rand(-1.5, 1.5);
  let time = spec.time;
  let scatter = 1;
  let clearance: number | undefined = spec.clearance;

  const power = kind === 'drive' || kind === 'smash' || kind === 'speedup' || kind === 'blast';
  if (powered && kind === 'smash') time *= 0.8;
  const low = lowAttackPenalty(kind, from, powered);
  if (timing.grade === 'perfect') {
    scatter = powered ? 0.3 : 0.35;
    if (power) time *= powered ? 0.88 : 0.9;
  } else if (timing.grade === 'good' && powered) {
    // Power without perfect timing is loose: sometimes it sails long or wide.
    scatter = 1.4;
    if (Math.random() < 0.3) {
      lateral += (Math.random() < 0.5 ? -1 : 1) * rand(3, 5.5);
      depth += rand(3, 6);
    }
  } else if (timing.grade === 'early' || timing.grade === 'late') {
    // A mistimed shot goes wrong one of three ways, more likely the worse the timing.
    const bad = Math.min(1, (timing.error - 0.12) / 0.2);
    const roll = Math.random();
    const soft = !power && kind !== 'lob';
    if (roll < 0.25 + 0.2 * bad + (powered ? 0.15 : 0)) {
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
      const miss = (2.5 + Math.max(0, timing.error - 0.12) * 30) * (powered ? 1.6 : 1);
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
  const hardSwing = power || kind === 'lob';
  scatter += pressure * (hardSwing ? 1.6 : 0.4) + onTheRun * 1.1;
  if (pressure > 0.5 && hardSwing && timing.grade !== 'perfect' && Math.random() < 0.3 * pressure) {
    // Rushed: the swing is late on the pace and the ball flies long or wide.
    lateral += (Math.random() < 0.5 ? -1 : 1) * rand(2, 4);
    depth += rand(1, 4);
  }

  if (low > 0) {
    // Attacking a low ball near the net: it floats up slow and high, or sails long.
    time *= 1 + 0.9 * low;
    clearance = 0.8 + 2 * low;
    depth += rand(0, 5) * low;
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
    spin: topspin(target.clone().sub(from), spec.spin),
    clearance,
  };
}
