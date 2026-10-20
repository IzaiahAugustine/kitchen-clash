import { Vector3, type Object3D } from 'three';
import { PracticeBot } from '../ai/practiceBot';
import type { BallEvent } from '../physics/ball';
import { predictPath, type PathSample } from '../physics/predict';
import { strikeGeometry } from '../players/body';
import {
  MAX_EARLY_LEAD,
  beginSwing,
  executeShot,
  findContact,
  reachAtContact,
  stretchTiming,
  type ShotReport,
} from '../players/hitting';
import { HumanController } from '../players/humanController';
import { PALETTES, type Palette } from '../players/palette';
import { LUNGE_REACH, Player } from '../players/player';
import { PlayerView } from '../players/playerView';
import { SHOT_NAMES, type ShotKind } from '../players/shots';
import { BounceMarkers } from '../render/markers';
import { isInCourt, sideOf } from './court';
import { hasDebugFlag } from './debugFlags';
import type { GameMode, World } from './mode';

/** Spot just above a player's head, for floating feedback tags. */
const overHead = (p: Player) => new Vector3(p.pos.x, 6.8, p.pos.z);

/** Extra reach (ft) the human gets when planning a hit: a lunge plus a little forgiveness. */
const HUMAN_REACH = 2.6;

const GRADE_TEXT = {
  perfect: { text: 'Perfect!', kind: 'good' },
  good: { text: 'Nice!', kind: 'info' },
  early: { text: 'Early', kind: 'bad' },
  late: { text: 'Late', kind: 'bad' },
} as const;

/**
 * Phase 2: rally practice against a bot. The bot feeds you balls; there's no serving
 * or scoring yet (phase 3), just in/out calls and a rally counter.
 */
export class PracticeMode implements GameMode {
  private human: Player;
  private bot: Player;
  private views: [Player, PlayerView][];
  private humanCtl: HumanController;
  private botAi: PracticeBot;
  /** `?autoplay`: a bot plays your side too (testing / screenshots). */
  private autopilot: PracticeBot | null = null;
  private markers: BounceMarkers;
  private path: PathSample[] = [];
  private lastHitter: Player | null = null;
  private bouncesSinceHit = 0;
  private live = false;
  private nextFeedIn = 1.0;
  private rally = 0;
  private best = 0;
  private lastShot = '—';

  /**
   * @param template player model; null runs without visuals (headless simulation)
   * @param autopilot a bot plays the human's side (also `?autoplay`)
   */
  constructor(
    private w: World,
    template: Object3D | null,
    autopilot = hasDebugFlag('autoplay'),
    palette?: Palette,
  ) {
    this.human = new Player('You', 1, palette ?? PALETTES.hero);
    this.human.pos.set(2, 0, 19);
    this.bot = new Player('Practice Bot', -1, PALETTES.rival);
    this.bot.pos.set(0, 0, -18);
    this.bot.maxSpeed = 14;
    this.humanCtl = new HumanController(this.human);
    this.botAi = new PracticeBot(this.bot);
    if (autopilot) this.autopilot = new PracticeBot(this.human);
    this.markers = new BounceMarkers(w.scene);
    this.views = template
      ? [this.human, this.bot].map((p) => {
          const v = new PlayerView(template, p.palette);
          w.scene.add(v.root);
          return [p, v];
        })
      : [];
  }

  dispose(): void {
    for (const [, v] of this.views) this.w.scene.remove(v.root);
    this.markers.dispose();
  }

  update(dt: number, time: number): void {
    const { ball, controls } = this.w;
    const input = controls.frame;
    if (input.feed && !this.live) this.nextFeedIn = 0;

    this.path = predictPath(ball, 1.8, this.path);
    const humanIncoming = this.live && this.lastHitter !== this.human;
    const preview =
      humanIncoming && !this.human.swing
        ? findContact(this.human, this.query(1.6, HUMAN_REACH), ball.flight)
        : null;
    const button = this.humanCtl.update(input, preview);
    if (this.autopilot) {
      const actx = {
        time,
        ball,
        path: this.path,
        bouncesSinceHit: this.bouncesSinceHit,
        incoming: humanIncoming,
        opponent: this.bot,
      };
      const b = this.autopilot.update(actx);
      if (b && this.human.canSwing(time)) this.human.swing = beginSwing(b, time, this.autopilot.query(actx));
    } else if (button && this.human.canSwing(time)) {
      const contact = humanIncoming
        ? findContact(this.human, this.query(MAX_EARLY_LEAD + 0.3, HUMAN_REACH), ball.flight)
        : null;
      const swing = beginSwing(button, time, contact);
      this.human.swing = swing;
      if (swing.note) this.w.hud.tag(swing.note, 'bad', overHead(this.human));
    }

    const ctx = {
      time,
      ball,
      path: this.path,
      bouncesSinceHit: this.bouncesSinceHit,
      incoming: this.live && this.lastHitter !== this.bot,
      opponent: this.human,
    };
    const botButton = this.botAi.update(ctx);
    if (botButton && this.bot.canSwing(time)) this.bot.swing = beginSwing(botButton, time, this.botAi.query(ctx));

    if (!this.live && !this.bot.swing?.feed) {
      this.nextFeedIn -= dt;
      if (this.nextFeedIn <= 0) this.feed(time);
    }

    for (const [p, v] of this.views) v.update(p, time, dt, ball.pos);
    this.markers.update(dt);
  }

  fixedUpdate(dt: number, time: number): void {
    const { ball } = this.w;
    for (const p of [this.human, this.bot]) {
      p.step(dt, time);
      const sw = p.swing;
      if (!sw || sw.resolved || !sw.contact || time + 1e-9 < sw.contactAt) continue;
      sw.resolved = true;
      const canHit = sw.feed || (this.live && ball.inPlay && ball.flight === sw.contact.flight && this.lastHitter !== p);
      if (!canHit) continue;
      if (!sw.feed) {
        const reach = reachAtContact(p);
        if (reach === 'miss') {
          if (p === this.human) this.w.hud.tag('Too far!', 'bad', overHead(p));
          continue;
        }
        if (reach === 'stretch' && sw.timing) {
          sw.timing = stretchTiming(sw.timing);
          if (p === this.human) this.w.hud.tag('Stretch!', 'bad', overHead(p));
        }
      }
      const aim = p === this.bot ? this.botAi.aim : (this.autopilot?.aim ?? this.humanCtl.aim);
      this.onHit(p, executeShot(ball, p, sw, aim), !!sw.feed, time);
    }
  }

  onBallEvent(e: BallEvent): void {
    if (!this.live || !this.lastHitter) return;
    const hitter = this.lastHitter;
    if (e.type === 'net') {
      this.endRally(hitter === this.human ? 'Into the net!' : 'Bot netted it!', hitter !== this.human);
    } else if (e.type === 'netcord') {
      this.w.hud.tag('Net cord!', 'info', new Vector3(e.x, 4, 0));
    } else if (e.type === 'bounce') {
      this.bouncesSinceHit++;
      if (this.bouncesSinceHit === 1) {
        const inside = isInCourt(e.x, e.z) && sideOf(e.z) !== hitter.side;
        this.markers.add(e.x, e.z, inside);
        if (!inside) this.endRally(hitter === this.human ? 'OUT' : 'Bot hit it out!', hitter !== this.human);
      } else if (this.bouncesSinceHit === 2) {
        this.endRally(hitter === this.human ? 'WINNER!' : 'Missed it!', hitter === this.human);
      }
    }
  }

  describe(): string {
    return `
      <div class="title">Dinkzilla <small>Practice · Phase 2</small></div>
      <div><b>WASD</b> move + <b>J</b> <b>K</b> <b>L</b> hit &nbsp;·&nbsp; or <b>Arrows</b> + <b>Z</b> <b>X</b> <b>C</b></div>
      <div><b>L</b> Spin: topspin roll at the net, slice from the back. Hardest to time!</div>
      <div><b>J / Z</b> Drive · dink at the kitchen · smash high balls</div>
      <div><b>K / X</b> Soft · drop from the back · reset midcourt · lob at the kitchen</div>
      <div><b>Enter</b> Feed now</div>
      <hr/>
      <div class="big">Rally ${this.rally} <span class="dim">· Best ${this.best}</span></div>
      <div>Last shot: ${this.lastShot}</div>`;
  }

  cornerText(): string {
    return `<span class="big">Rally ${this.rally}</span> <span class="dim">· Best ${this.best} · <b>Enter</b> feed</span>`;
  }

  cameraTargetX(): number {
    return this.human.pos.x;
  }

  private query(maxTime: number, slack: number) {
    return { path: this.path, bouncesSoFar: this.bouncesSinceHit, maxTime, slack };
  }

  private onHit(p: Player, report: ShotReport, feed: boolean, time: number): void {
    this.lastHitter = p;
    // The other player split-steps as the ball is struck.
    for (const other of [this.human, this.bot]) if (other !== p) other.splitStepAt = time;
    this.bouncesSinceHit = 0;
    this.live = true;
    if (!feed) this.rally++;
    this.best = Math.max(this.best, this.rally);
    if (p === this.bot) {
      this.botAi.onHit(report.kind);
      return;
    }
    const g = GRADE_TEXT[report.timing.grade];
    if (!this.human.swing || this.human.contactGap() <= LUNGE_REACH) this.w.hud.tag(g.text, g.kind, overHead(this.human));
    this.lastShot = `${SHOT_NAMES[report.kind]} · ${report.mph.toFixed(0)} mph · ${g.text}`;
  }

  private endRally(message: string, good: boolean): void {
    this.live = false;
    this.nextFeedIn = 1.6;
    this.w.hud.flash(message, good ? 'good' : 'bad', 1200);
  }

  /** The bot drops a ball and feeds it to you. */
  private feed(time: number): void {
    const { ball } = this.w;
    const bot = this.bot;
    const g = strikeGeometry(2.6, 'fore');
    const hold = new Vector3(
      bot.pos.x + bot.right.x * g.lateral,
      2.6,
      bot.pos.z + bot.forward.z * g.forward,
    );
    ball.hold(hold);
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.rally = 0;
    const humanUp = Math.abs(this.human.pos.z) < 11;
    const kind: ShotKind = Math.random() < (humanUp ? 0.5 : 0.6) ? 'drive' : 'drop';
    this.botAi.aim = { x: (Math.random() - 0.5) * 1.4, y: (Math.random() - 0.5) * 0.8 };
    bot.swing = beginSwing(
      'drive',
      time,
      { t: 0.45, pos: hold, hand: 'fore', standAt: bot.pos.clone(), crouch: g.crouch, flight: ball.flight, bounced: true },
      { kind, feed: true, timing: { grade: 'good', error: 0 } },
    );
  }
}
