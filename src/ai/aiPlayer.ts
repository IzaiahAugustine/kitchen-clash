import { Vector3 } from 'three';
import { COURT, inKitchen } from '../game/court';
import type { Ball } from '../physics/ball';
import type { PathSample } from '../physics/predict';
import { IDEAL_LEAD, findContact } from '../players/hitting';
import type { Contact, Player } from '../players/player';
import type { Aim, ShotButton, ShotKind } from '../players/shots';
import type { AiProfile } from './difficulty';

export interface AiContext {
  time: number;
  ball: Ball;
  path: PathSample[];
  bouncesSinceHit: number;
  /** The ball is live and coming to this player. */
  incoming: boolean;
  opponent: Player;
  /** Hits so far this rally (1 = the serve has been struck). */
  hitCount: number;
  /** The two-bounce rule applies to the next hit. */
  mustLetBounce: boolean;
  isServer: boolean;
}

export interface AiSwing {
  button: ShotButton;
  contact: Contact;
  /** Shot override for the few shots buttons can't express (a deep punch volley). */
  kind?: ShotKind;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** Roughly normal, mean 0, std-dev 1. */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Where to stand when waiting: at the kitchen line, or back at the baseline. */
const KITCHEN_SPOT = COURT.kitchenDepth + 0.9;
const BASELINE_SPOT = COURT.halfLength - 2.5;
const TRANSITION_SPOT = 14;

/**
 * Computer player. Plays real pickleball: deep returns then up to the kitchen, third-shot
 * drops against a net player, dinks at the net, drives and lobs when the opponent is stuck
 * back, and aims away from the opponent. The profile sets how well it does all that.
 */
export class AiPlayer {
  aim: Aim = { x: 0, y: 0 };
  private plannedFlight = -1;
  private lead = IDEAL_LEAD;
  private button: ShotButton = 'drive';
  private kind: ShotKind | undefined;
  private reactUntil = 0;
  /** Wants to be at the kitchen line (vs. staying back). */
  private goingUp = false;
  private lazy = false;
  /** This shot ignores the kitchen / two-bounce rule (a believable mistake). */
  private slip = false;

  constructor(
    readonly player: Player,
    readonly profile: AiProfile,
  ) {
    player.maxSpeed = 14 * profile.speed;
  }

  /** A new rally is about to start. */
  onRallyStart(): void {
    this.goingUp = false;
    this.lazy = Math.random() < this.profile.lazyFeet;
    this.plannedFlight = -1;
  }

  /** The opponent just hit: it takes a moment to read the shot. */
  onOpponentHit(time: number): void {
    this.reactUntil = time + this.profile.reaction * rand(0.7, 1.3);
  }

  /** It just hit: decide where to go next. */
  onHit(kind: ShotKind, isReturn: boolean): void {
    if (isReturn || kind === 'dink' || kind === 'drop' || kind === 'reset' || kind === 'smash' || kind === 'lob') {
      this.goingUp = true;
    } else if (kind === 'drive') {
      // Better players follow their drive in.
      this.goingUp = this.goingUp || Math.random() < this.profile.shotIQ * 0.5;
    }
  }

  /** Picks a serve: usually safe; sometimes a risky deep one. */
  chooseServe(): { button: ShotButton; aim: Aim } {
    const risky = Math.random() < this.profile.serveRisk;
    if (risky) return { button: 'drive', aim: { x: rand(-1, 1), y: rand(0.8, 1) } };
    const hard = Math.random() < this.profile.shotIQ * 0.4;
    return { button: hard ? 'drive' : 'soft', aim: { x: rand(-0.7, 0.7), y: rand(-0.2, 0.5) } };
  }

  /** Sets movement intent; returns a swing to start when it's time. */
  update(ctx: AiContext): AiSwing | null {
    const p = this.player;
    if (p.swing && p.swing.contact && !p.swing.resolved) return null; // committed, running in
    if (ctx.time < this.reactUntil) return null; // still reading the shot: keep doing what it was doing

    // Chase the ball down even when it's a stretch; giving up early looks robotic.
    const contact = ctx.incoming ? (this.findContact(ctx) ?? this.findContact(ctx, true)) : null;
    if (!contact) {
      this.position(ctx);
      return null;
    }
    if (ctx.ball.flight !== this.plannedFlight) {
      this.plannedFlight = ctx.ball.flight;
      this.slip = Math.random() < this.profile.ruleSlip;
      this.lead = IDEAL_LEAD + gauss() * this.profile.timingNoise;
      if (Math.random() < this.profile.blunder) this.lead += (Math.random() < 0.5 ? -1 : 1) * rand(0.18, 0.3);
      this.decide(contact, ctx);
    }
    this.moveToward(contact.standAt);
    if (contact.t <= Math.max(0, this.lead) && p.canSwing(ctx.time)) {
      return { button: this.button, contact, kind: this.kind };
    }
    return null;
  }

  /** Where it can hit the ball. @param desperate settle for the closest-to-reachable point */
  findContact(ctx: AiContext, desperate = false): Contact | null {
    const p = this.player;
    return findContact(
      p,
      {
        path: ctx.path,
        bouncesSoFar: ctx.bouncesSinceHit,
        maxTime: 2.2,
        slack: this.profile.reach,
        reaction: Math.max(0, this.reactUntil - ctx.time),
        mustBounce: !this.slip && (ctx.mustLetBounce || inKitchen(p.pos.z)),
        bestEffort: desperate,
      },
      ctx.ball.flight,
    );
  }

  /** Shot selection: the heart of the strategy. */
  private decide(c: Contact, ctx: AiContext): void {
    const p = this.player;
    const opp = ctx.opponent;
    const fromNet = Math.abs(c.pos.z);
    const oppFromNet = Math.abs(opp.pos.z);
    const atKitchen = fromNet <= COURT.kitchenDepth + 3;
    const oppUp = oppFromNet <= COURT.kitchenDepth + 4;
    const oppBack = oppFromNet >= 15;
    const smart = Math.random() < this.profile.shotIQ;
    let button: ShotButton = 'drive';
    let kind: ShotKind | undefined;
    let depth = rand(-0.4, 0.4);

    if (ctx.hitCount === 1) {
      // Return of serve: deep, to keep the server pinned back while it comes to the net.
      button = smart || Math.random() < 0.6 ? 'drive' : 'soft';
      depth = smart ? rand(0.4, 0.9) : rand(-0.6, 0.6);
    } else if (ctx.hitCount === 2 && ctx.isServer && oppUp) {
      // Third shot against a returner at the net: the drop (sometimes a drive).
      button = smart ? (Math.random() < 0.8 ? 'soft' : 'drive') : Math.random() < 0.5 ? 'soft' : 'drive';
    } else if (atKitchen) {
      if (c.pos.y >= 3.4) button = 'drive'; // put away the high ball
      else if (smart && !c.bounced && c.pos.y >= 2.6 && Math.random() < 0.45) {
        // A dink that sat up a little: speed it up with a hard volley at the opponent.
        kind = 'drive';
        depth = rand(-0.6, 0.2);
      } else if (oppBack && smart && !c.bounced && c.pos.y >= 2.2) {
        // Opponent stuck back: punch the volley deep instead of dinking.
        kind = 'drive';
        depth = rand(0.3, 0.8);
      } else if (oppUp && oppFromNet < COURT.kitchenDepth + 1.4 && smart && Math.random() < 0.12) {
        button = 'soft'; // lob a player crowding the net
      } else if (!smart && Math.random() < 0.12) {
        button = 'soft'; // a poorly chosen lob
      } else {
        button = 'drive'; // dink
      }
    } else if (oppUp) {
      // From the back or midcourt against a net player: drop / reset soft into the kitchen.
      button = smart ? (Math.random() < 0.85 ? 'soft' : 'drive') : Math.random() < 0.5 ? 'soft' : 'drive';
    } else {
      // Both back: drive deep, sometimes drop to start coming in.
      button = smart ? (Math.random() < 0.75 ? 'drive' : 'soft') : Math.random() < 0.5 ? 'drive' : 'soft';
      depth = rand(0, 0.8);
    }

    // Aim away from the opponent (in this hitter's left/right terms), wider for better players.
    const oppLateral = opp.pos.x * p.right.x;
    const away = Math.abs(oppLateral) < 1 ? (Math.random() < 0.5 ? -1 : 1) : -Math.sign(oppLateral);
    const wrongFoot = smart && Math.random() < 0.2 ? -1 : 1;
    let x = away * wrongFoot * this.profile.angle * rand(0.6, 1);
    x += gauss() * 0.15 * (1 - this.profile.shotIQ);
    this.button = button;
    this.kind = kind;
    this.aim = { x: clamp(x, -1, 1), y: clamp(depth + gauss() * 0.15, -1, 1) };
  }

  /** Where to wait between shots: back for the serve/return, then up to the kitchen line. */
  private position(ctx: AiContext): void {
    const p = this.player;
    let depth: number;
    if (ctx.isServer && ctx.hitCount <= 2) depth = BASELINE_SPOT; // stay back for the return
    else if (!ctx.isServer && ctx.hitCount <= 1) depth = COURT.halfLength - 0.5; // waiting on the serve
    else if (this.goingUp) depth = this.lazy ? TRANSITION_SPOT : KITCHEN_SPOT;
    else depth = Math.abs(p.pos.z) < TRANSITION_SPOT ? TRANSITION_SPOT : BASELINE_SPOT;
    // Shade toward the side the ball is on, mirroring the opponent.
    const x = clamp(ctx.opponent.pos.x * 0.35, -5, 5);
    this.moveToward(new Vector3(x, 0, p.side * depth));
  }

  private moveToward(target: Vector3): void {
    const p = this.player;
    const dx = target.x - p.pos.x;
    const dz = target.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.1) {
      p.intent.set(0, 0, 0);
      return;
    }
    const speed = Math.min(p.maxSpeed, d * 5);
    p.intent.set((dx / d) * speed, 0, (dz / d) * speed);
  }
}
