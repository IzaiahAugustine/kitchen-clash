import { Vector3 } from 'three';
import { inKitchen } from '../game/court';
import type { Ball } from '../physics/ball';
import type { PathSample } from '../physics/predict';
import { IDEAL_LEAD, findContact } from '../players/hitting';
import type { Contact, Player } from '../players/player';
import { type Aim, type ShotButton, type ShotKind } from '../players/shots';

export interface BotContext {
  time: number;
  ball: Ball;
  path: PathSample[];
  bouncesSinceHit: number;
  /** The ball is live and heading to (or already on) this bot's side. */
  incoming: boolean;
  opponent: Player;
  /** Rules say this hit must come after a bounce (two-bounce rule). */
  mustLetBounce?: boolean;
  /** Override where to wait between shots (distance from the net). */
  homeDepth?: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Phase 2 practice partner: chases the ball down and returns it with sensible shots.
 * The real AI (difficulty levels, strategy, mistakes) comes in phase 4.
 */
export class PracticeBot {
  aim: Aim = { x: 0, y: 0 };
  /** Random error (s) in when it presses the button; bigger = sloppier timing. */
  timingNoise = 0.035;
  private lead = IDEAL_LEAD;
  private plannedFlight = -1;
  private button: ShotButton = 'drive';
  private lastKind: ShotKind | null = null;

  constructor(readonly player: Player) {}

  query(ctx: BotContext): Contact | null {
    const p = this.player;
    return findContact(
      p,
      {
        path: ctx.path,
        bouncesSoFar: ctx.bouncesSinceHit,
        maxTime: 2,
        slack: 1.0,
        // Plays by the rules: lets it bounce during the two-bounce rule or when in the kitchen.
        mustBounce: !!ctx.mustLetBounce || inKitchen(p.pos.z),
      },
      ctx.ball.flight,
    );
  }

  /** Sets movement intent; returns a shot button when it's time to swing. */
  update(ctx: BotContext): ShotButton | null {
    const p = this.player;
    if (p.swing && p.swing.contact && !p.swing.resolved) return null; // committed, already gliding in
    const contact = ctx.incoming ? this.query(ctx) : null;
    if (!contact) {
      this.goHome(ctx.ball, ctx.homeDepth);
      return null;
    }
    if (ctx.ball.flight !== this.plannedFlight) {
      this.plannedFlight = ctx.ball.flight;
      this.lead = IDEAL_LEAD + rand(-this.timingNoise, this.timingNoise);
      this.decide(contact, ctx.opponent);
    }
    this.moveToward(contact.standAt);
    return contact.t <= this.lead && p.canSwing(ctx.time) ? this.button : null;
  }

  onHit(kind: ShotKind): void {
    this.lastKind = kind;
  }

  private decide(c: Contact, opponent: Player): void {
    const atKitchen = Math.abs(c.pos.z) <= 10;
    const oppAtKitchen = Math.abs(opponent.pos.z) <= 11;
    if (atKitchen) this.button = c.pos.y >= 3.6 || Math.random() < 0.88 ? 'drive' : 'soft';
    else if (oppAtKitchen) this.button = Math.random() < 0.65 ? 'soft' : 'drive';
    else this.button = Math.random() < 0.7 ? 'drive' : 'soft';
    this.aim = { x: rand(-0.8, 0.8), y: rand(-0.6, 0.6) };
  }

  private goHome(ball: Ball, depth?: number): void {
    const p = this.player;
    const soft = this.lastKind === 'dink' || this.lastKind === 'drop' || this.lastKind === 'reset';
    const home = new Vector3(Math.max(-5, Math.min(5, ball.pos.x * 0.3)), 0, p.side * (depth ?? (soft ? 8.8 : 18.5)));
    this.moveToward(home);
  }

  private moveToward(target: Vector3): void {
    const p = this.player;
    const dx = target.x - p.pos.x;
    const dz = target.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      p.intent.set(0, 0, 0);
      return;
    }
    const speed = Math.min(p.maxSpeed, d * 5);
    p.intent.set((dx / d) * speed, 0, (dz / d) * speed);
  }
}
