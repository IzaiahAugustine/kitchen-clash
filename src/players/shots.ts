import { Vector3 } from 'three';
import { COURT, type Side } from '../game/court';
import { topspin } from '../physics/trajectory';
import type { Hand } from './body';

export type ShotKind = 'drive' | 'smash' | 'dink' | 'drop' | 'reset' | 'lob' | 'serve';
export type ShotButton = 'drive' | 'soft';

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
};

/**
 * Context shots: the same button does different things depending on where you are.
 *   Drive button: drive from the back, dink at the kitchen, smash a high ball at the kitchen.
 *   Soft button:  drop from the baseline, reset from midcourt, lob from the kitchen.
 */
export function chooseShotKind(button: ShotButton, contact: Vector3): ShotKind {
  const fromNet = Math.abs(contact.z);
  const atKitchen = fromNet <= COURT.kitchenDepth + 3;
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

/** Turns a shot kind + aim + timing into a landing target and shape. */
export function planShot(
  kind: ShotKind,
  from: Vector3,
  hitterSide: Side,
  hand: Hand,
  aim: Aim,
  timing: Timing,
): ShotPlan {
  const spec = SPECS[kind];
  // The hitter's right is +x on the near side and -x on the far side.
  const right = hitterSide;
  let depth = spec.depth[0] + (spec.depth[1] - spec.depth[0]) * (0.5 + 0.5 * aim.y);
  let lateral = Math.abs(aim.x) >= 0.2 ? aim.x * spec.width : right * (from.x * 0.35) + rand(-1.5, 1.5);
  let time = spec.time;
  let scatter = 1;
  let clearance: number | undefined = spec.clearance;

  const power = kind === 'drive' || kind === 'smash';
  if (timing.grade === 'perfect') {
    scatter = 0.35;
    if (power) time *= 0.9;
  } else if (timing.grade === 'early' || timing.grade === 'late') {
    // A mistimed shot goes wrong one of three ways, more likely the worse the timing.
    const bad = Math.min(1, (timing.error - 0.12) / 0.2);
    const roll = Math.random();
    const soft = !power && kind !== 'lob';
    if (roll < 0.25 + 0.2 * bad) {
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
      const miss = 2.5 + Math.max(0, timing.error - 0.12) * 30;
      const dir = (timing.grade === 'early' ? -1 : 1) * (hand === 'fore' ? 1 : -1);
      lateral += dir * miss;
      depth += rand(-2.5, 2.5);
      if (power) time *= 1.15;
      clearance = spec.clearance * 0.3;
    }
    scatter = 1.5;
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
