import { Vector3 } from 'three';
import { BODY, legPose, type Hand } from './body';
import type { ShotKind } from './shots';

/**
 * Right-arm pose. Shoulder Euler angles use order YZX: pitch (sx) swings the hanging arm
 * forward, raise (sz) lifts it out to the side, and turn (sy) sweeps it around the body.
 */
export interface ArmPose {
  sx: number;
  sy: number;
  sz: number;
  /** Elbow bend (forearm forward). */
  ex: number;
  /** Upper-body turn. */
  spineY: number;
  crouch: number;
}

export const READY_POSE: ArmPose = { sx: 0.5, sy: 0.3, sz: 0.35, ex: 0.9, spineY: 0, crouch: 0.22 };

export type SwingStyle = 'drive' | 'smash' | 'dink' | 'drop' | 'lob';

export function styleFor(kind: ShotKind | 'whiff'): SwingStyle {
  switch (kind) {
    case 'smash':
    case 'dink':
    case 'lob':
      return kind;
    case 'drop':
    case 'reset':
    case 'serve':
      return 'drop';
    default:
      return 'drive';
  }
}

export interface SwingPoses {
  wind: ArmPose;
  contact: ArmPose;
  follow: ArmPose;
}

/**
 * Builds the three key poses of a swing. The contact pose is solved so the arm points
 * straight at the ball (`contactLocal`, relative to the player's feet in model space:
 * +x right, -z forward); the wind-up and follow-through are offsets from it.
 */
export function buildSwingPoses(style: SwingStyle, hand: Hand, contactLocal: Vector3, crouch: number): SwingPoses {
  const shoulder = new Vector3(BODY.shoulderX, BODY.shoulderY - legPose(crouch).drop, 0);
  const d = contactLocal.clone().sub(shoulder).normalize();
  const sz = Math.acos(Math.min(1, Math.max(-1, -d.y)));
  let sy = Math.atan2(-d.z, d.x);
  // Keep backhands on the "around the front" branch so blends sweep across the body, not behind it.
  if (hand === 'back' && sy < 0) sy += Math.PI * 2;

  const contact: ArmPose = { sx: 0, sy, sz, ex: 0.12, spineY: 0, crouch };
  const k = hand === 'fore' ? 1 : -1;
  const at = (p: Partial<ArmPose>): ArmPose => ({ ...contact, ...p });

  switch (style) {
    case 'drive':
      return {
        wind: at({ sy: sy - 1.5 * k, ex: 0.55, spineY: -0.6 * k }),
        contact,
        follow: at({ sy: sy + 1.6 * k, sz: sz - 0.15, ex: 1.3, spineY: 0.7 * k, crouch: crouch * 0.6 }),
      };
    case 'smash':
      return {
        wind: at({ sz: Math.min(sz + 0.5, 3.0), ex: 1.5, spineY: -0.4 }),
        contact,
        follow: at({ sz: 0.4, ex: 0.4, spineY: 0.4, crouch: crouch + 0.15 }),
      };
    case 'dink':
      return {
        wind: at({ sx: -0.35, ex: 0.3, spineY: -0.1 * k }),
        contact,
        follow: at({ sx: 0.55, ex: 0.4 }),
      };
    case 'drop':
      return {
        wind: at({ sx: -0.75, ex: 0.2, spineY: -0.25 * k }),
        contact,
        follow: at({ sx: 1.15, ex: 0.4 }),
      };
    case 'lob':
      return {
        wind: at({ sx: -0.85, ex: 0.15, spineY: -0.2 * k }),
        contact,
        follow: at({ sx: 1.9, sz: sz - 0.2, ex: 0.2, crouch: crouch * 0.3 }),
      };
  }
}

export function lerpPose(a: ArmPose, b: ArmPose, t: number): ArmPose {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    sx: l(a.sx, b.sx),
    sy: l(a.sy, b.sy),
    sz: l(a.sz, b.sz),
    ex: l(a.ex, b.ex),
    spineY: l(a.spineY, b.spineY),
    crouch: l(a.crouch, b.crouch),
  };
}
