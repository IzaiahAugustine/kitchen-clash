import { Vector3, type Object3D } from 'three';
import { AiPlayer, type AiContext } from '../ai/aiPlayer';
import { PROFILES, type Difficulty } from '../ai/difficulty';
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
import { isInCourt, sideOf } from './court';
import type { GameMode, World } from './mode';

const HUMAN_REACH = 2.6;
/** Seconds between the end of a rally and the next serve. */
const BETWEEN_POINTS = 2.2;
/** How long an AI waits before serving. */
const AI_SERVE_DELAY = 1.3;
/** Wind-up time of the underhand serve. */
const SERVE_SWING = 0.5;

const GRADE_TEXT = {
  perfect: { text: 'Perfect!', kind: 'good' },
  good: { text: 'Nice!', kind: 'info' },
  early: { text: 'Early', kind: 'bad' },
  late: { text: 'Late', kind: 'bad' },
} as const;

type Phase = 'preServe' | 'rally' | 'pointOver' | 'gameOver';

/** Who plays a side: you, or an AI at some difficulty. */
export type Controller = 'human' | Difficulty;

export interface MatchOptions {
  scoring: ScoreConfig;
  /** Near side (team 0). 'human' for you; a difficulty for AI vs AI. */
  near: Controller;
  /** Far side (team 1). */
  far: Controller;
}

export const DEFAULT_MATCH: MatchOptions = { scoring: DEFAULT_SCORING, near: 'human', far: 'medium' };

interface Side {
  player: Player;
  name: string;
  human: HumanController | null;
  ai: AiPlayer | null;
}

/**
 * A singles game with full pickleball rules: underhand diagonal serve, two-bounce rule,
 * kitchen, faults, and side-out (or rally) scoring with correct serving sides.
 * Team 0 plays the near side, team 1 the far side; either can be you or an AI.
 */
export class MatchMode implements GameMode {
  private sides: [Side, Side];
  private views: [Player, PlayerView][];
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
    readonly opts: MatchOptions = DEFAULT_MATCH,
  ) {
    const make = (team: Team, c: Controller): Side => {
      const player = new Player(c === 'human' ? 'You' : `CPU`, team === 0 ? 1 : -1, team === 0 ? PALETTES.hero : PALETTES.rival);
      return {
        player,
        name: c === 'human' ? 'YOU' : `CPU ${PROFILES[c].label.toUpperCase()}`,
        human: c === 'human' ? new HumanController(player) : null,
        ai: c === 'human' ? null : new AiPlayer(player, PROFILES[c]),
      };
    };
    this.sides = [make(0, opts.near), make(1, opts.far)];
    this.markers = new BounceMarkers(w.scene);
    this.views = template
      ? this.sides.map(({ player }) => {
          const v = new PlayerView(template, player.palette);
          w.scene.add(v.root);
          return [player, v] as [Player, PlayerView];
        })
      : [];
    this.newGame();
  }

  /** Display names for the two teams. */
  get names(): [string, string] {
    return [this.sides[0].name, this.sides[1].name];
  }

  /** Results of finished rallies and games, newest last (for tests / the headless sim). */
  get history(): readonly string[] {
    return this.log;
  }

  get currentScore(): Score {
    return this.score;
  }

  private get watching(): boolean {
    return !this.sides.some((s) => s.human);
  }

  private get server(): Side {
    return this.sides[this.score.servingTeam];
  }

  private get receiver(): Side {
    return this.sides[this.score.receivingTeam];
  }

  private newGame(): void {
    this.score = new Score(this.opts.scoring, Math.random() < 0.5 ? 0 : 1);
    this.scoreboard?.hideGameOver();
    this.setupServe();
  }

  /** Line both players up for the next serve and call the score. */
  private setupServe(): void {
    this.phase = 'preServe';
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.setup = serveSetup(this.server.player.side, this.score.serveFromRight());
    for (const s of this.sides) {
      s.player.swing = null;
      s.player.vel.set(0, 0, 0);
      s.player.intent.set(0, 0, 0);
      s.ai?.onRallyStart();
    }
    this.server.player.pos.copy(this.setup.serverPos);
    this.receiver.player.pos.copy(this.setup.receiverPos);
    this.phaseTimer = this.server.ai ? AI_SERVE_DELAY : 0;
    this.holdBallForServe();
    const who = this.server.human ? 'Your serve' : `${this.server.name} serves`;
    this.w.hud.flash(this.score.call(), 'info', 1400, who);
    this.scoreboard?.update(this.score);
  }

  private serveHoldPos(): Vector3 {
    const s = this.server.player;
    const g = strikeGeometry(1.8, 'fore');
    return new Vector3(s.pos.x + s.right.x * g.lateral, 1.8, s.pos.z + s.forward.z * g.forward);
  }

  private holdBallForServe(): void {
    if (!this.server.player.swing) this.w.ball.hold(this.serveHoldPos());
  }

  /** Underhand serve: the server swings at the held ball; the shot is planned from the aim now. */
  private serve(time: number, button: ShotButton, aim: Aim): void {
    const s = this.server.player;
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
      this.phaseTimer -= dt;
      if (input.feed || (this.watching && this.phaseTimer <= 0)) this.newGame();
    } else if (this.phase === 'pointOver') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.setupServe();
    }

    for (const s of this.sides) {
      if (s.human) this.updateHuman(s, s.human, time);
      else if (s.ai) this.updateAi(s, s.ai, time, dt);
    }

    if (this.phase === 'preServe') {
      if (!this.server.player.swing) clampServer(this.server.player, this.setup);
      this.holdBallForServe();
    }

    for (const [p, v] of this.views) v.update(p, time, dt, ball.pos);
    this.markers.update(dt);
    this.scoreboard?.update(this.score);
  }

  private updateHuman(s: Side, ctl: HumanController, time: number): void {
    const p = s.player;
    const ball = this.w.ball;
    const incoming = this.phase === 'rally' && this.lastHitter !== p;
    const preview = incoming && !p.swing ? findContact(p, this.query(1.6), ball.flight) : null;
    const button = ctl.update(this.w.controls.frame, preview);
    if (!button) return;
    if (this.phase === 'preServe' && this.server === s && !p.swing) {
      this.serve(time, button, ctl.aim);
    } else if (this.phase === 'rally' && p.canSwing(time)) {
      const contact = incoming
        ? chooseHumanContact(p, this.query(MAX_EARLY_LEAD + 0.3), ball.flight, this.referee.mustLetBounce)
        : null;
      const swing = beginSwing(button, time, contact);
      p.swing = swing;
      if (swing.note) this.w.hud.flash(swing.note, 'bad', 700);
    }
  }

  private updateAi(s: Side, ai: AiPlayer, time: number, dt: number): void {
    const p = s.player;
    if (this.phase === 'preServe') {
      p.intent.set(0, 0, 0);
      if (this.server === s && !p.swing) {
        this.phaseTimer -= dt;
        if (this.phaseTimer > 0) return;
        const { button, aim } = ai.chooseServe();
        this.serve(time, button, aim);
      }
      return;
    }
    const ctx = this.aiContext(s, time);
    const swing = ai.update(ctx);
    if (swing && p.canSwing(time)) p.swing = beginSwing(swing.button, time, swing.contact, { kind: swing.kind });
  }

  private aiContext(s: Side, time: number): AiContext {
    return {
      time,
      ball: this.w.ball,
      path: this.path,
      bouncesSinceHit: this.bouncesSinceHit,
      incoming: this.phase === 'rally' && this.lastHitter !== s.player,
      opponent: (s === this.sides[0] ? this.sides[1] : this.sides[0]).player,
      hitCount: this.referee.hitCount,
      mustLetBounce: this.referee.mustLetBounce,
      isServer: s === this.server,
    };
  }

  fixedUpdate(dt: number, time: number): void {
    const { ball } = this.w;
    for (const s of this.sides) {
      const p = s.player;
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
        this.afterHit(s, time);
        if (s.human) this.lastShot = 'Serve';
        continue;
      }

      const canHit = this.phase === 'rally' && ball.inPlay && ball.flight === sw.contact.flight && this.lastHitter !== p;
      if (!canHit) continue;
      const reach = reachAtContact(p);
      if (reach === 'miss') {
        if (s.human) this.w.hud.flash('Too far!', 'bad', 800);
        continue;
      }
      if (reach === 'stretch' && sw.timing) {
        sw.timing = stretchTiming(sw.timing);
        if (s.human) this.w.hud.flash('Stretch!', 'bad', 700);
      }
      const bounced = this.bouncesSinceHit > 0;
      const isReturn = this.referee.hitCount === 1;
      const fault = this.referee.onHit(p.side, bounced, p.pos.z, time);
      const report = executeShot(ball, p, sw, s.ai?.aim ?? s.human!.aim);
      s.ai?.onHit(report.kind, isReturn);
      this.afterHit(s, time);
      if (fault) this.endRally(fault);
      else this.onGoodHit(s, report);
    }
  }

  private afterHit(s: Side, time: number): void {
    this.lastHitter = s.player;
    this.bouncesSinceHit = 0;
    for (const other of this.sides) {
      if (other === s) continue;
      other.player.splitStepAt = time;
      other.ai?.onOpponentHit(time);
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
    if (this.watching) {
      return `
        <div class="title">Kitchen Clash <small>Watching AI vs AI</small></div>
        <div class="big">${this.sides[0].name} vs ${this.sides[1].name}</div>
        <div><b>F</b> Fast-forward · <b>T</b> Slow-mo</div>`;
    }
    const yourServe = this.phase === 'preServe' && this.server.human;
    const hint = yourServe
      ? '<div class="big ok">Your serve! J = hard serve · K = safe serve (aim with A/D)</div>'
      : this.phase === 'gameOver'
        ? '<div class="big">Press Enter for a rematch</div>'
        : '';
    return `
      <div class="title">Kitchen Clash <small>vs ${this.sides[1].name}</small></div>
      <div><b>WASD</b> move + <b>J</b> <b>K</b> hit &nbsp;·&nbsp; or <b>Arrows</b> move + <b>Z</b> <b>X</b> hit</div>
      <div><b>J</b> Drive · dink · smash &nbsp; <b>K</b> Soft · drop · reset · lob</div>
      ${hint}
      <hr/>
      <div>Last shot: ${this.lastShot}</div>`;
  }

  cameraTargetX(): number {
    return this.watching ? this.w.ball.pos.x : this.sides[0].player.pos.x;
  }

  private query(maxTime: number) {
    return { path: this.path, bouncesSoFar: this.bouncesSinceHit, maxTime, slack: HUMAN_REACH };
  }

  private onGoodHit(s: Side, report: ShotReport): void {
    if (!s.human) return;
    const g = GRADE_TEXT[report.timing.grade];
    if (s.player.contactGap() <= LUNGE_REACH) this.w.hud.flash(g.text, g.kind, 800);
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
    const loserSide = this.sides[loser];
    const who = loserSide.human ? 'You' : loserSide.name;
    const result =
      outcome.pointTo !== null
        ? `Point ${this.sides[outcome.pointTo].human ? 'you' : this.sides[outcome.pointTo].name}!`
        : outcome.sideOut
          ? 'Side out!'
          : 'Second server';
    const good = this.watching ? true : !loserSide.human;
    this.w.hud.flash(text.title, good ? 'good' : 'bad', 2000, `${who}: ${text.detail} · ${result}`);
    this.log.push(`${fault.reason}:${loser}:${servingBefore === loser ? 'server' : 'receiver'}`);
    this.scoreboard?.update(this.score);

    const w = this.score.winner();
    if (w !== null) {
      this.phase = 'gameOver';
      this.phaseTimer = 4;
      const [a, b] = [this.score.points[w], this.score.points[otherTeam(w)]];
      const title = this.sides[w].human ? 'YOU WIN!' : `${this.sides[w].name} WINS`;
      this.scoreboard?.showGameOver(title, `${a} – ${b}`);
      this.log.push(`game:${w}:${a}-${b}`);
    } else if (this.score.gamePointFor() !== null) {
      setTimeout(() => this.w.hud.flash('GAME POINT', 'info', 1200), 1000);
    }
  }
}
