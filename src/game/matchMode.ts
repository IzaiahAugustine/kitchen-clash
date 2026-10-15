import { Vector3, type Object3D } from 'three';
import { PracticeBot, type BotContext } from '../ai/practiceBot';
import type { BallEvent } from '../physics/ball';
import { predictPath, type PathSample } from '../physics/predict';
import { strikeGeometry } from '../players/body';
import {
  MAX_EARLY_LEAD,
  beginSwing,
  chooseHumanContact,
  executeShot,
  findContact,
  reachAtContact,
  stretchTiming,
  type ShotReport,
} from '../players/hitting';
import { HumanController } from '../players/humanController';
import { PALETTES } from '../players/palette';
import { LUNGE_REACH, Player, type Swing } from '../players/player';
import { PlayerView } from '../players/playerView';
import { SHOT_NAMES, type Aim, type ShotButton } from '../players/shots';
import { BounceMarkers } from '../render/markers';
import { FAULT_TEXT, Referee, type Fault } from '../rules/referee';
import { DEFAULT_SCORING, Score, otherTeam, teamOfSide, type ScoreConfig, type Team } from '../rules/scoring';
import { clampServer, planServe, serveSetup, type ServeSetup } from '../rules/serve';
import type { Scoreboard } from '../ui/scoreboard';
import { COURT, isInCourt, sideOf } from './court';
import { hasDebugFlag } from './debugFlags';
import type { GameMode, World } from './mode';

const HUMAN_REACH = 2.6;
/** Seconds between the end of a rally and the next serve. */
const BETWEEN_POINTS = 2.2;
/** How long the bot waits before serving. */
const BOT_SERVE_DELAY = 1.3;
/** Wind-up time of the underhand serve. */
const SERVE_SWING = 0.5;

const GRADE_TEXT = {
  perfect: { text: 'Perfect!', kind: 'good' },
  good: { text: 'Nice!', kind: 'info' },
  early: { text: 'Early', kind: 'bad' },
  late: { text: 'Late', kind: 'bad' },
} as const;

type Phase = 'preServe' | 'rally' | 'pointOver' | 'gameOver';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * A singles game with full pickleball rules: underhand diagonal serve, two-bounce rule,
 * kitchen, faults, and side-out (or rally) scoring with correct serving sides.
 * You play the near side; team 0 is you, team 1 the bot (the full AI comes in phase 4).
 */
export class MatchMode implements GameMode {
  private players: [Player, Player];
  private human: Player;
  private bot: Player;
  private views: [Player, PlayerView][];
  private humanCtl: HumanController;
  private botAi: PracticeBot;
  private autopilot: PracticeBot | null;
  private markers: BounceMarkers;
  private referee = new Referee();
  private score!: Score;
  private setup!: ServeSetup;
  private phase: Phase = 'preServe';
  private phaseTimer = 0;
  private path: PathSample[] = [];
  private lastHitter: Player | null = null;
  private bouncesSinceHit = 0;
  private lastShot = '—';
  private log: string[] = [];

  constructor(
    private w: World,
    template: Object3D | null,
    private scoreboard: Scoreboard | null,
    private cfg: ScoreConfig = DEFAULT_SCORING,
    autopilot = hasDebugFlag('autoplay'),
  ) {
    this.human = new Player('You', 1, PALETTES.hero);
    this.bot = new Player('Bot', -1, PALETTES.rival);
    this.bot.maxSpeed = 13.5;
    this.players = [this.human, this.bot];
    this.humanCtl = new HumanController(this.human);
    this.botAi = new PracticeBot(this.bot);
    // Until the phase 4 AI: a decent but beatable opponent.
    this.botAi.timingNoise = 0.1;
    this.autopilot = autopilot ? new PracticeBot(this.human) : null;
    this.markers = new BounceMarkers(w.scene);
    this.views = template
      ? this.players.map((p) => {
          const v = new PlayerView(template, p.palette);
          w.scene.add(v.root);
          return [p, v] as [Player, PlayerView];
        })
      : [];
    this.newGame();
  }

  /** Results of finished rallies, newest last (for tests / the headless sim). */
  get history(): readonly string[] {
    return this.log;
  }

  get currentScore(): Score {
    return this.score;
  }

  private newGame(): void {
    this.score = new Score(this.cfg, Math.random() < 0.5 ? 0 : 1);
    this.scoreboard?.hideGameOver();
    this.setupServe();
  }

  private get server(): Player {
    return this.players[this.score.servingTeam];
  }

  private get receiver(): Player {
    return this.players[this.score.receivingTeam];
  }

  /** Line both players up for the next serve and call the score. */
  private setupServe(): void {
    this.phase = 'preServe';
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.setup = serveSetup(this.server.side, this.score.serveFromRight());
    for (const p of this.players) {
      p.swing = null;
      p.vel.set(0, 0, 0);
      p.intent.set(0, 0, 0);
    }
    this.server.pos.copy(this.setup.serverPos);
    this.receiver.pos.copy(this.setup.receiverPos);
    this.phaseTimer = this.server === this.bot || this.autopilot ? BOT_SERVE_DELAY : 0;
    this.holdBallForServe();
    const who = this.server === this.human ? 'Your serve' : 'Bot serves';
    this.w.hud.flash(this.score.call(), 'info', 1400, who);
    this.scoreboard?.update(this.score);
  }

  private serveHoldPos(): Vector3 {
    const s = this.server;
    const g = strikeGeometry(1.8, 'fore');
    return new Vector3(s.pos.x + s.right.x * g.lateral, 1.8, s.pos.z + s.forward.z * g.forward);
  }

  private holdBallForServe(): void {
    if (!this.server.swing) this.w.ball.hold(this.serveHoldPos());
  }

  /** Underhand serve: the server swings at the held ball; the shot is planned from the aim now. */
  private serve(time: number, button: ShotButton, aim: Aim): void {
    const s = this.server;
    const hold = this.serveHoldPos();
    this.w.ball.hold(hold);
    const g = strikeGeometry(hold.y, 'fore');
    const swing: Swing = beginSwing(
      button,
      time,
      { t: SERVE_SWING, pos: hold, hand: 'fore', standAt: s.pos.clone(), crouch: g.crouch, flight: this.w.ball.flight, bounced: true },
      { kind: 'serve', feed: true, timing: { grade: 'good', error: 0 } },
    );
    swing.plan = planServe(s, this.setup, aim, button, hold);
    s.swing = swing;
  }

  update(dt: number, time: number): void {
    const { ball, controls } = this.w;
    const input = controls.frame;
    this.path = predictPath(ball);

    if (this.phase === 'gameOver') {
      if (input.feed || (this.autopilot && (this.phaseTimer -= dt) <= 0)) this.newGame();
    } else if (this.phase === 'pointOver') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.setupServe();
    }

    // --- your player
    const humanIncoming = this.phase === 'rally' && this.lastHitter !== this.human;
    const preview =
      humanIncoming && !this.human.swing ? findContact(this.human, this.query(1.6), ball.flight) : null;
    const button = this.humanCtl.update(input, preview);
    if (this.autopilot) {
      this.drivePlayerByBot(this.autopilot, this.human, this.bot, time, dt);
    } else if (button) {
      if (this.phase === 'preServe' && this.server === this.human && !this.human.swing) {
        this.serve(time, button, this.humanCtl.aim);
      } else if (this.phase === 'rally' && this.human.canSwing(time)) {
        const contact = humanIncoming
          ? chooseHumanContact(this.human, this.query(MAX_EARLY_LEAD + 0.3), ball.flight, this.referee.mustLetBounce)
          : null;
        const swing = beginSwing(button, time, contact);
        this.human.swing = swing;
        if (swing.note) this.w.hud.flash(swing.note, 'bad', 700);
      }
    }

    // --- the bot
    this.drivePlayerByBot(this.botAi, this.bot, this.human, time, dt);

    if (this.phase === 'preServe') {
      if (!this.server.swing) clampServer(this.server, this.setup);
      this.holdBallForServe();
    }

    for (const [p, v] of this.views) v.update(p, time, dt, ball.pos);
    this.markers.update(dt);
    this.scoreboard?.update(this.score);
  }

  /** Runs a bot-controlled player: serving when it's their serve, otherwise rallying. */
  private drivePlayerByBot(ai: PracticeBot, p: Player, opponent: Player, time: number, dt: number): void {
    if (this.phase === 'preServe') {
      p.intent.set(0, 0, 0);
      if (this.server === p && !p.swing) {
        // Bots serve after a short pause.
        this.phaseTimer -= dt;
        if (this.phaseTimer > 0) return;
        const button: ShotButton = Math.random() < 0.7 ? 'soft' : 'drive';
        this.serve(time, button, { x: rand(-0.8, 0.8), y: rand(-0.5, 0.5) });
      }
      return;
    }
    const ctx: BotContext = {
      time,
      ball: this.w.ball,
      path: this.path,
      bouncesSinceHit: this.bouncesSinceHit,
      incoming: this.phase === 'rally' && this.lastHitter !== p,
      opponent,
      mustLetBounce: this.referee.mustLetBounce,
      homeDepth: this.homeDepthFor(p),
    };
    const b = ai.update(ctx);
    if (b && p.canSwing(time)) p.swing = beginSwing(b, time, ai.query(ctx));
  }

  /**
   * Basic positioning (the phase 4 AI will be smarter): the server stays back for the
   * return, the returner moves up to the kitchen line after returning.
   */
  private homeDepthFor(p: Player): number | undefined {
    if (this.phase !== 'rally') return undefined;
    const hits = this.referee.hitCount;
    if (p === this.server && hits <= 2) return COURT.halfLength - 2;
    if (p === this.receiver && hits >= 2) return COURT.kitchenDepth + 1.8;
    return undefined;
  }

  fixedUpdate(dt: number, time: number): void {
    const { ball } = this.w;
    for (const p of this.players) {
      p.step(dt, time);
      if (this.phase === 'rally') {
        const f = this.referee.watchPlayer(p.side, p.pos.z, time);
        if (f) this.endRally(f);
      }
      const sw = p.swing;
      if (!sw || sw.resolved || !sw.contact || time + 1e-9 < sw.contactAt) continue;
      sw.resolved = true;

      if (sw.feed) {
        // The serve.
        if (this.phase !== 'preServe') continue;
        executeShot(ball, p, sw, { x: 0, y: 0 });
        this.referee.startRally(p.side, this.setup.boxSide);
        this.phase = 'rally';
        this.lastHitter = p;
        this.bouncesSinceHit = 0;
        this.markShot(p, 'Serve');
        continue;
      }

      const canHit = this.phase === 'rally' && ball.inPlay && ball.flight === sw.contact.flight && this.lastHitter !== p;
      if (!canHit) continue;
      const reach = reachAtContact(p);
      if (reach === 'miss') {
        if (p === this.human) this.w.hud.flash('Too far!', 'bad', 800);
        continue;
      }
      if (reach === 'stretch' && sw.timing) {
        sw.timing = stretchTiming(sw.timing);
        if (p === this.human) this.w.hud.flash('Stretch!', 'bad', 700);
      }
      const bounced = this.bouncesSinceHit > 0;
      const fault = this.referee.onHit(p.side, bounced, p.pos.z, time);
      const aim = p === this.bot ? this.botAi.aim : (this.autopilot?.aim ?? this.humanCtl.aim);
      const report = executeShot(ball, p, sw, aim);
      this.lastHitter = p;
      this.bouncesSinceHit = 0;
      for (const other of this.players) if (other !== p) other.splitStepAt = time;
      if (p === this.bot) this.botAi.onHit(report.kind);
      else this.autopilot?.onHit(report.kind);
      if (fault) this.endRally(fault);
      else this.onGoodHit(p, report);
    }
  }

  onBallEvent(e: BallEvent): void {
    if (this.phase !== 'rally') return;
    if (e.type === 'net') {
      const f = this.referee.onNet();
      if (f) this.endRally(f);
    } else if (e.type === 'netcord') {
      this.w.hud.flash('Net cord!', 'info', 800);
    } else if (e.type === 'bounce') {
      this.bouncesSinceHit++;
      if (this.bouncesSinceHit === 1 && this.lastHitter) {
        this.markers.add(e.x, e.z, isInCourt(e.x, e.z) && sideOf(e.z) !== this.lastHitter.side);
      }
      const f = this.referee.onBounce(e.x, e.z);
      if (f) this.endRally(f);
    }
  }

  describe(): string {
    const you = this.server === this.human;
    const hint =
      this.phase === 'preServe' && you
        ? '<div class="big ok">Your serve! J = hard serve · K = safe serve (aim with A/D)</div>'
        : this.phase === 'gameOver'
          ? '<div class="big">Press Enter for a rematch</div>'
          : '';
    return `
      <div class="title">Kitchen Clash <small>Match · Phase 3</small></div>
      <div><b>WASD</b> move + <b>J</b> <b>K</b> hit &nbsp;·&nbsp; or <b>Arrows</b> move + <b>Z</b> <b>X</b> hit</div>
      <div><b>J</b> Drive · dink · smash &nbsp; <b>K</b> Soft · drop · reset · lob</div>
      ${hint}
      <hr/>
      <div>Last shot: ${this.lastShot}</div>`;
  }

  cameraTargetX(): number {
    return this.human.pos.x;
  }

  private query(maxTime: number) {
    return { path: this.path, bouncesSoFar: this.bouncesSinceHit, maxTime, slack: HUMAN_REACH };
  }

  private markShot(p: Player, text: string): void {
    if (p === this.human) this.lastShot = text;
  }

  private onGoodHit(p: Player, report: ShotReport): void {
    if (p !== this.human || this.autopilot) {
      if (p === this.human) this.lastShot = `${SHOT_NAMES[report.kind]} · ${report.mph.toFixed(0)} mph`;
      return;
    }
    const g = GRADE_TEXT[report.timing.grade];
    if (this.human.contactGap() <= LUNGE_REACH) this.w.hud.flash(g.text, g.kind, 800);
    this.lastShot = `${SHOT_NAMES[report.kind]} · ${report.mph.toFixed(0)} mph · ${g.text}`;
  }

  /** A fault ends the rally: score it, explain it, and set up the next serve (or end the game). */
  private endRally(fault: Fault): void {
    if (this.phase !== 'rally') return;
    this.phase = 'pointOver';
    this.phaseTimer = BETWEEN_POINTS;
    const loser: Team = teamOfSide(fault.side);
    const winner = otherTeam(loser);
    const servingBefore = this.score.servingTeam;
    const outcome = this.score.rallyWonBy(winner);
    const text = FAULT_TEXT[fault.reason];
    const youFaulted = this.players[loser] === this.human;
    const who = youFaulted ? 'You' : 'Bot';
    const result = outcome.pointTo !== null
      ? `Point ${outcome.pointTo === 0 ? 'you' : 'bot'}!`
      : outcome.sideOut
        ? 'Side out!'
        : 'Second server';
    this.w.hud.flash(text.title, youFaulted ? 'bad' : 'good', 2000, `${who}: ${text.detail} · ${result}`);
    this.log.push(`${fault.reason}:${who}:${servingBefore === loser ? 'server' : 'receiver'}:${result}`);
    this.scoreboard?.update(this.score);

    const w = this.score.winner();
    if (w !== null) {
      this.phase = 'gameOver';
      this.phaseTimer = 3;
      const [a, b] = [this.score.points[w], this.score.points[otherTeam(w)]];
      this.scoreboard?.showGameOver(w === 0 ? 'YOU WIN!' : 'BOT WINS', `${a} – ${b}`);
      this.log.push(`game:${w === 0 ? 'you' : 'bot'}:${a}-${b}`);
    } else if (this.score.gamePointFor() !== null) {
      setTimeout(() => this.w.hud.flash('GAME POINT', 'info', 1200), 1000);
    }
  }
}
