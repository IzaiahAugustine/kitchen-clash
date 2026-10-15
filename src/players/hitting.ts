import { Vector3 } from 'three';
import type { Ball } from '../physics/ball';
import type { PathSample } from '../physics/predict';
import { solveShot } from '../physics/trajectory';
import { BODY, strikeGeometry, type Hand } from './body';
import type { Contact, Player, Swing } from './player';
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
  /** How fast (ft/s) the player can cover ground to get to the ball. */
  moveRate: number;
  /** Free reach (ft) before any movement is needed. */
  slack: number;
  /** Ball must bounce first (two-bounce rule). */
  mustBounce?: boolean;
}

/**
 * Finds where this player can hit the ball. Prefers the moment the ball crosses the
 * player's hitting plane (just in front of the body); otherwise the last reachable point
 * before the ball dies.
 */
export function findContact(player: Player, q: ContactQuery, flight: number): Contact | null {
  const planeZ = player.pos.z + player.forward.z * BODY.contactForward;
  let fallback: PathSample | null = null;
  let fallbackBounced = false;
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
    const need = Math.hypot(sx - player.pos.x, sz - player.pos.z);
    if (need > q.slack + q.moveRate * s.t) continue;
    if (crossed) return makeContact(player, s, flight, totalBounces > 0);
    fallback = s;
    fallbackBounced = totalBounces > 0;
  }
  return fallback ? makeContact(player, fallback, flight, fallbackBounced) : null;
}

function handFor(player: Player, ballX: number): Hand {
  return (ballX - player.pos.x) * player.right.x >= -0.3 ? 'fore' : 'back';
}

function makeContact(player: Player, s: PathSample, flight: number, bounced: boolean): Contact {
  const hand = handFor(player, s.x);
  const g = strikeGeometry(s.y, hand);
  return {
    t: s.t,
    pos: new Vector3(s.x, s.y, s.z),
    hand,
    standAt: new Vector3(s.x - player.right.x * g.lateral, 0, s.z - player.forward.z * g.forward),
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
  const plan = planShot(kind, from, player.side, swing.hand, aim, timing);
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
