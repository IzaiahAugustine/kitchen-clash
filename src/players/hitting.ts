import { Vector3 } from 'three';
import { COURT, FOOT_REACH, inKitchen } from '../game/court';
import type { Ball } from '../physics/ball';
import type { PathSample } from '../physics/predict';
import { solveShot } from '../physics/trajectory';
import { BODY, strikeGeometry, type Hand } from './body';
import { LUNGE_REACH, STRETCH_REACH, type Contact, type Player, type Swing } from './player';
import { chooseShotKind, planShot, type Aim, type ShotButton, type ShotKind, type Timing } from './shots';
import { buildSwingPoses, styleFor } from './swingPoses';

/** Pressing the button this long before contact is a Perfect. */
export const IDEAL_LEAD = 0.2;
/** Pressing earlier than this whiffs. */
export const MAX_EARLY_LEAD = 0.85;
export const MIN_CONTACT_HEIGHT = 0.6;
export const MAX_CONTACT_HEIGHT = 6.4;

export function gradeTiming(lead: number): Timing {
  const d = lead - IDEAL_LEAD;
  const error = Math.abs(d);
  if (error <= 0.05) return { grade: 'perfect', error };
  if (error <= 0.12) return { grade: 'good', error };
  return { grade: d > 0 ? 'early' : 'late', error };
}

export interface ContactQuery {
  path: PathSample[];
  /** Bounces since the ball was last hit. */
  bouncesSoFar: number;
  maxTime: number;
  /** Reach (ft) on top of running: how far from the ideal spot a hit still works. */
  slack: number;
  /** Seconds before the player starts moving (reaction time). */
  reaction?: number;
  /** Ball must bounce first (two-bounce rule). */
  mustBounce?: boolean;
  /** If nothing is reachable, return the closest-to-reachable point anyway (chase it down). */
  bestEffort?: boolean;
}

/**
 * Finds where this player can hit the ball. Prefers the moment the ball crosses the
 * player's hitting plane (just in front of the body); otherwise the earliest point they
 * can get to (a stable target, so they don't chase a spot that keeps sliding away).
 */
export function findContact(player: Player, q: ContactQuery, flight: number): Contact | null {
  const planeZ = player.pos.z + player.forward.z * BODY.contactForward;
  let fallback: PathSample | null = null;
  let fallbackBounced = false;
  let closest: PathSample | null = null;
  let closestBounced = false;
  let closestShort = Infinity;
  let prevZ = Number.NaN;
  for (const s of q.path) {
    if (s.t > q.maxTime || s.netted) break;
    const totalBounces = q.bouncesSoFar + s.bounces;
    if (totalBounces >= 2) break;
    const crossed = !Number.isNaN(prevZ) && (prevZ - planeZ) * (s.z - planeZ) <= 0;
    prevZ = s.z;
    if (player.side * s.z < 0.5) continue;
    if (q.mustBounce && totalBounces === 0) continue;
    if (s.y < MIN_CONTACT_HEIGHT || s.y > MAX_CONTACT_HEIGHT) continue;

    const hand = handFor(player, s.x);
    const g = strikeGeometry(s.y, hand);
    const sx = s.x - player.right.x * g.lateral;
    const sz = s.z - player.forward.z * g.forward;
    const dx = sx - player.pos.x;
    const dz = sz - player.pos.z;
    const need = Math.hypot(dx, dz);
    const short = need - q.slack - player.coverable(s.t - (q.reaction ?? 0), dx, dz);
    if (short > 0) {
      if (short < closestShort) {
        closestShort = short;
        closest = s;
        closestBounced = totalBounces > 0;
      }
      continue;
    }
    if (crossed) return makeContact(player, s, flight, totalBounces > 0);
    if (!fallback) {
      fallback = s;
      fallbackBounced = totalBounces > 0;
    }
  }
  if (fallback) return makeContact(player, fallback, flight, fallbackBounced);
  return q.bestEffort && closest ? makeContact(player, closest, flight, closestBounced) : null;
}

/**
 * Contact at a specific moment on the ball's path (an online friend already chose when to hit
 * on their screen). Null if that moment isn't on the path or the ball is dead by then.
 */
export function contactAtTime(player: Player, path: PathSample[], t: number, bouncesSoFar: number, flight: number): Contact | null {
  if (t <= 0 || !path.length) return null;
  const dt = path[0].t;
  const s = path[Math.min(path.length - 1, Math.max(0, Math.round(t / dt) - 1))];
  if (Math.abs(s.t - t) > 0.05 || s.netted || bouncesSoFar + s.bounces >= 2) return null;
  if (player.side * s.z < 0.5 || s.y < MIN_CONTACT_HEIGHT || s.y > MAX_CONTACT_HEIGHT) return null;
  return makeContact(player, s, flight, bouncesSoFar + s.bounces > 0);
}

/** Contact with the ball at a given point right now (online rewind: a hit that arrived late). */
export function contactAtPoint(player: Player, pos: Vector3, bounced: boolean, flight: number): Contact {
  return makeContact(player, { t: 1e-4, x: pos.x, y: pos.y, z: pos.z, bounces: 0, netted: false }, flight, bounced);
}

function handFor(player: Player, ballX: number): Hand {
  return (ballX - player.pos.x) * player.right.x >= -0.3 ? 'fore' : 'back';
}

/** Volleys are planned from behind the kitchen line: auto-movement never walks you into a fault. */
const VOLLEY_LINE = COURT.kitchenDepth + FOOT_REACH + 0.1;

function makeContact(player: Player, s: PathSample, flight: number, bounced: boolean): Contact {
  const hand = handFor(player, s.x);
  const g = strikeGeometry(s.y, hand);
  let standZ = s.z - player.forward.z * g.forward;
  if (!bounced && Math.abs(standZ) < VOLLEY_LINE) standZ = player.side * VOLLEY_LINE;
  return {
    t: s.t,
    pos: new Vector3(s.x, s.y, s.z),
    hand,
    standAt: new Vector3(s.x - player.right.x * g.lateral, 0, standZ),
    crouch: g.crouch,
    flight,
    bounced,
  };
}

/**
 * Starts a swing. With a contact, the swing is timed to meet the ball and graded on how
 * early/late the button was pressed; without one (or if pressed far too early) it whiffs.
 */
export function beginSwing(
  button: ShotButton,
  time: number,
  contact: Contact | null,
  opts: { kind?: ShotKind; feed?: boolean; timing?: Timing } = {},
): Swing {
  let note: string | undefined;
  if (contact && contact.t > MAX_EARLY_LEAD) {
    contact = null;
    note = 'Too early!';
  }
  if (!contact) {
    const g = strikeGeometry(3, 'fore');
    const contactAt = time + 0.16;
    return {
      button,
      kind: 'whiff',
      hand: 'fore',
      startAt: time,
      contactAt,
      endAt: contactAt + 0.3,
      contact: null,
      timing: null,
      poses: buildSwingPoses('drive', 'fore', new Vector3(g.lateral, 3, -g.forward), g.crouch),
      resolved: false,
      note,
    };
  }

  const kind = opts.kind ?? chooseShotKind(button, contact.pos);
  const g = strikeGeometry(contact.pos.y, contact.hand);
  const local = new Vector3(g.lateral, contact.pos.y, -g.forward);
  const contactAt = time + contact.t;
  return {
    button,
    kind,
    hand: contact.hand,
    startAt: time,
    contactAt,
    endAt: contactAt + 0.3,
    contact,
    timing: opts.timing ?? gradeTiming(contact.t),
    poses: buildSwingPoses(styleFor(kind), contact.hand, local, g.crouch),
    resolved: false,
    feed: opts.feed,
  };
}

/**
 * At contact: is the player close enough to the ideal spot? Within a lunge is fine, a bit
 * farther is a weak stretched shot, beyond that the ball gets past them.
 */
export function reachAtContact(player: Player): 'ok' | 'stretch' | 'miss' {
  const gap = player.contactGap();
  if (gap <= LUNGE_REACH) return 'ok';
  return gap <= STRETCH_REACH ? 'stretch' : 'miss';
}

/** A stretched shot plays like a mistimed one: less pace, sprays wide. */
export function stretchTiming(t: Timing): Timing {
  return { grade: t.grade === 'early' ? 'early' : 'late', error: Math.max(t.error, 0.16) };
}

/**
 * Picks the contact for a human's swing, playing by the rules when possible: while the
 * two-bounce rule applies, or when standing in the kitchen, it lets the ball bounce first.
 * Only if that's out of reach does it fall back to a volley (which the referee may fault).
 */
export function chooseHumanContact(player: Player, q: ContactQuery, flight: number, mustLetBounce: boolean): Contact | null {
  if (mustLetBounce || inKitchen(player.pos.z)) {
    const safe = findContact(player, { ...q, mustBounce: true }, flight);
    if (safe) return safe;
  }
  // Out of reach? Still go for it: the swing becomes a stretch or a "Too far!" miss.
  return findContact(player, q, flight) ?? findContact(player, { ...q, bestEffort: true }, flight);
}

export interface ShotReport {
  kind: ShotKind;
  mph: number;
  timing: Timing;
  target: Vector3;
}

/** Hits the ball: plans the shot from aim + timing, solves the launch, and sends it. */
export function executeShot(ball: Ball, player: Player, swing: Swing, aim: Aim): ShotReport {
  const kind = swing.kind as ShotKind;
  const timing = swing.timing ?? { grade: 'good', error: 0 };
  const from = ball.pos.clone();
  const plan = swing.plan ?? planShot(kind, from, player.side, swing.hand, aim, timing, swing.button === 'power');
  const sol = solveShot({
    from,
    target: plan.target,
    flightTime: plan.flightTime,
    spin: plan.spin,
    minNetClearance: plan.clearance,
  });
  ball.launch(from, sol.velocity, plan.spin);
  swing.resolved = true;
  return { kind, mph: sol.velocity.length() * 0.6818, timing, target: plan.target };
}
