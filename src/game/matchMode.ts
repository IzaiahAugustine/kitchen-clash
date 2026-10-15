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
import { PALETTES, type Palette } from '../players/palette';
import { LUNGE_REACH, Player, type Contact, type Swing } from '../players/player';
import { PlayerView } from '../players/playerView';
import { SHOT_NAMES, type Aim, type ShotButton } from '../players/shots';
import { BounceMarkers } from '../render/markers';
import { FAULT_TEXT, Referee, type Fault } from '../rules/referee';
import { DEFAULT_SCORING, Score, otherTeam, teamOfSide, type ScoreConfig, type Team } from '../rules/scoring';
import { ServeRotation, clampServer, planServe, serveSetup, type Court, type ServeSetup } from '../rules/serve';
import type { Scoreboard } from '../ui/scoreboard';
import { COURT, isInCourt, sideOf, type Side } from './court';
import type { GameMode, World } from './mode';

const HUMAN_REACH = 2.6;
/** Seconds between the end of a rally and the next serve. */
const BETWEEN_POINTS = 2.2;
/** How long an AI waits before serving. */
const AI_SERVE_DELAY = 1.3;
/** Wind-up time of the underhand serve. */
const SERVE_SWING = 0.5;
/** Doubles partners keep at least this far apart. */
const PARTNER_SPACING = 2.4;

const GRADE_TEXT = {
  perfect: { text: 'Perfect!', kind: 'good' },
  good: { text: 'Nice!', kind: 'info' },
  early: { text: 'Early', kind: 'bad' },
  late: { text: 'Late', kind: 'bad' },
} as const;

type Phase = 'preServe' | 'rally' | 'pointOver' | 'gameOver';

/** Spot just above a player's head, for floating feedback tags. */
const overHead = (p: Player) => new Vector3(p.pos.x, 6.8, p.pos.z);

/** Middle of a court half (x), from that team's own point of view (their right is +x on the near side). */
const courtX = (side: Side, court: Court) => (court === 'right' ? 1 : -1) * side * 5;

/** Who plays a side: you (with an AI partner in doubles), or an AI at some difficulty. */
export type Controller = 'human' | Difficulty;

export interface MatchOptions {
  /** `teamSize` 1 = singles, 2 = doubles. */
  scoring: ScoreConfig;
  /** Near side (team 0). 'human' for you; a difficulty for AI vs AI. */
  near: Controller;
  /** Far side (team 1). */
  far: Controller;
}

export const DEFAULT_MATCH: MatchOptions = { scoring: DEFAULT_SCORING, near: 'human', far: 'medium' };

export interface MatchResult {
  /** Team 0 (near) or 1 (far). */
  winner: Team;
  names: [string, string];
  points: [number, number];
  /** Longest rally, in shots. */
  longestRally: number;
  /** Your Perfect-timed shots (0 in AI vs AI). */
  perfects: number;
  /** Rallies won by each team. */
  ralliesWon: [number, number];
  /** True if a human played on team 0. */
  humanTeam: boolean;
}

/** One player slot on a team. */
interface Seat {
  team: Team;
  index: number;
  player: Player;
  human: HumanController | null;
  ai: AiPlayer | null;
}

const TEAM_PALETTES: [Palette[], Palette[]] = [
  [PALETTES.hero, PALETTES.partner],
  [PALETTES.rival, PALETTES.rival2],
];

const label = (c: Controller) => (c === 'human' ? 'YOU' : `CPU ${PROFILES[c].label.toUpperCase()}`);

/**
 * A game of pickleball with full rules: underhand diagonal serve, two-bounce rule, kitchen,
 * faults, and side-out (or rally) scoring with correct serving sides and, in doubles, the
 * server rotation. Team 0 plays the near side, team 1 the far side. In doubles you play
 * with an AI partner; partners split the court and call who takes each ball.
 */
export class MatchMode implements GameMode {
  private teams: [Seat[], Seat[]];
  private seats: Seat[];
  private teamNames: [string, string];
  private views: [Player, PlayerView][];
  private markers: BounceMarkers;
  private referee = new Referee();
  private score!: Score;
  private rotation!: ServeRotation;
  private setup!: ServeSetup;
  private phase: Phase = 'preServe';
  private phaseTimer = 0;
  private path: PathSample[] = [];
  private lastHitter: Seat | null = null;
  private receiverSeat: Seat | null = null;
  /** Doubles: which seat of each team is taking the current incoming ball. */
  private owner: [{ flight: number; seat: number }, { flight: number; seat: number }] = [
    { flight: -1, seat: 0 },
    { flight: -1, seat: 0 },
  ];
  private bouncesSinceHit = 0;
  private lastShot = '—';
  private log: string[] = [];
  private longestRally = 0;
  private perfects = 0;
  private ralliesWon: [number, number] = [0, 0];
  /** Called when a game with a human player ends (AI vs AI just starts a new game). */
  onGameOver: ((r: MatchResult) => void) | null = null;

  constructor(
    private w: World,
    template: Object3D | null,
    private scoreboard: Scoreboard | null,
    readonly opts: MatchOptions = DEFAULT_MATCH,
  ) {
    const size = opts.scoring.teamSize;
    const make = (team: Team, c: Controller): Seat[] =>
      Array.from({ length: size }, (_, index) => {
        // In doubles your partner plays at the opponents' level.
        const level: Difficulty = c === 'human' ? (opts.far === 'human' ? 'medium' : opts.far) : c;
        const human = c === 'human' && index === 0;
        const player = new Player(human ? 'You' : 'CPU', team === 0 ? 1 : -1, TEAM_PALETTES[team][index]);
        return {
          team,
          index,
          player,
          human: human ? new HumanController(player) : null,
          ai: human ? null : new AiPlayer(player, PROFILES[level]),
        };
      });
    this.teams = [make(0, opts.near), make(1, opts.far)];
    this.seats = [...this.teams[0], ...this.teams[1]];
    this.teamNames = [
      size === 2 && opts.near === 'human' ? 'YOU + CPU' : label(opts.near),
      label(opts.far),
    ];
    this.markers = new BounceMarkers(w.scene);
    this.views = template
      ? this.seats.map(({ player }) => {
          const v = new PlayerView(template, player.palette);
          w.scene.add(v.root);
          return [player, v] as [Player, PlayerView];
        })
      : [];
    this.newGame();
  }

  /** Display names for the two teams. */
  get names(): [string, string] {
    return this.teamNames;
  }

  /** Results of finished rallies and games, newest last (for tests / the headless sim). */
  get history(): readonly string[] {
    return this.log;
  }

  get currentScore(): Score {
    return this.score;
  }

  private get doubles(): boolean {
    return this.opts.scoring.teamSize === 2;
  }

  private get watching(): boolean {
    return !this.seats.some((s) => s.human);
  }

  private get you(): Seat | undefined {
    return this.seats.find((s) => s.human);
  }

  private get server(): Seat {
    const s = this.rotation.server;
    return this.teams[s.team][s.seat];
  }

  private partnerOf(seat: Seat): Seat | null {
    return this.teams[seat.team].find((s) => s !== seat) ?? null;
  }

  /** Start a fresh game (also used for rematches). */
  newGame(): void {
    this.score = new Score(this.opts.scoring, Math.random() < 0.5 ? 0 : 1);
    this.rotation = new ServeRotation(this.score);
    this.longestRally = 0;
    this.perfects = 0;
    this.ralliesWon = [0, 0];
    this.setupServe();
  }

  dispose(): void {
    for (const [, v] of this.views) this.w.scene.remove(v.root);
    this.markers.dispose();
  }

  /** Line everyone up for the next serve and call the score. */
  private setupServe(): void {
    this.phase = 'preServe';
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    for (const s of this.seats) {
      s.player.swing = null;
      s.player.vel.set(0, 0, 0);
      s.player.intent.set(0, 0, 0);
      s.ai?.onRallyStart();
    }
    const server = this.server;
    const r = this.rotation.receiver;
    const receiver = this.teams[r.team][r.seat];
    this.receiverSeat = receiver;
    this.setup = serveSetup(server.player.side, this.rotation.serverCourt === 'right');
    server.player.pos.copy(this.setup.serverPos);
    receiver.player.pos.copy(this.setup.receiverPos);
    // Doubles: the server's partner waits back (two-bounce rule); the receiver's partner at the kitchen.
    const sp = this.partnerOf(server);
    if (sp) {
      const side = sp.player.side;
      sp.player.pos.set(courtX(side, this.rotation.courtOf(sp.team, sp.index)), 0, side * (COURT.halfLength - 0.5));
    }
    const rp = this.partnerOf(receiver);
    if (rp) {
      const side = rp.player.side;
      rp.player.pos.set(courtX(side, this.rotation.courtOf(rp.team, rp.index)), 0, side * (COURT.kitchenDepth + 1.2));
    }
    this.phaseTimer = server.ai ? AI_SERVE_DELAY : 0;
    this.holdBallForServe();
    const who = server.human ? 'Your serve' : this.doubles ? `${this.teamNames[server.team]} serve` : `${this.teamNames[server.team]} serves`;
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
    const { ball } = this.w;
    this.path = predictPath(ball);

    if (this.phase === 'gameOver') {
      this.phaseTimer -= dt;
      if (this.watching && this.phaseTimer <= 0) this.newGame();
    } else if (this.phase === 'pointOver') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.setupServe();
    }

    if (this.doubles && this.phase === 'rally') {
      for (const team of [0, 1] as Team[]) if (this.incomingTo(team)) this.assignOwner(team, time);
    }

    for (const s of this.seats) {
      if (s.human) this.updateHuman(s, s.human, time);
      else if (s.ai) this.updateAi(s, s.ai, time, dt);
    }

    if (this.phase === 'preServe') {
      if (!this.server.player.swing) clampServer(this.server.player, this.setup);
      this.holdBallForServe();
    }
    this.updateGuides();

    for (const [p, v] of this.views) v.update(p, time, dt, ball.pos);
    this.markers.update(dt);
    this.scoreboard?.update(this.score);
  }

  /** On-court helpers for you: where the incoming ball lands, and where your serve must go. */
  private updateGuides(): void {
    const fx = this.w.fx;
    const you = this.you;
    if (!fx || !you) return;
    let landing: Vector3 | null = null;
    if (this.incomingTo(you.team) && this.bouncesSinceHit === 0) {
      const s = this.path.find((p) => p.bounces >= 1);
      if (s && sideOf(s.z) === you.player.side) landing = new Vector3(s.x, 0, s.z);
    }
    fx.setLanding(landing);
    const serving = this.phase === 'preServe' && this.server === you && !you.player.swing;
    if (!serving) {
      fx.setServeBox(null);
      return;
    }
    const rs = -you.player.side;
    const bx = this.setup.boxSide;
    fx.setServeBox({ x0: 0, x1: bx * COURT.halfWidth, z0: rs * COURT.kitchenDepth, z1: rs * COURT.halfLength });
  }

  private incomingTo(team: Team): boolean {
    return this.phase === 'rally' && this.lastHitter?.team !== team;
  }

  private ownsBall(seat: Seat): boolean {
    return !this.doubles || this.owner[seat.team].seat === seat.index;
  }

  /**
   * Doubles "mine!": decides which partner takes the incoming ball. The one who can get to it
   * most easily (forehands preferred in the middle), sticking with the call for that ball.
   */
  private assignOwner(team: Team, time: number): void {
    const flight = this.w.ball.flight;
    const own = this.owner[team];
    const seats = this.teams[team];
    const contactFor = (s: Seat): Contact | null =>
      s.ai ? s.ai.findContact(this.aiContext(s, time)) : findContact(s.player, this.query(1.6), flight);
    if (own.flight === flight) {
      // Keep the call unless that player can no longer get there and the partner can.
      const current = seats[own.seat];
      if (current.player.swing?.contact?.flight === flight || contactFor(current)) return;
      const other = seats[1 - own.seat];
      if (contactFor(other)) own.seat = other.index;
      return;
    }
    let best = 0;
    let bestScore = Infinity;
    for (const s of seats) {
      const c = contactFor(s);
      const score = c
        ? Math.hypot(c.standAt.x - s.player.pos.x, c.standAt.z - s.player.pos.z) - (c.hand === 'fore' ? 0.8 : 0)
        : 100 + this.distanceToBallPath(s);
      if (score < bestScore) {
        bestScore = score;
        best = s.index;
      }
    }
    this.owner[team] = { flight, seat: best };
  }

  /** How close a player gets to where the ball will be (fallback when nobody can reach it). */
  private distanceToBallPath(s: Seat): number {
    let d = Infinity;
    for (const p of this.path) d = Math.min(d, Math.hypot(p.x - s.player.pos.x, p.z - s.player.pos.z));
    return d;
  }

  private updateHuman(s: Seat, ctl: HumanController, time: number): void {
    const p = s.player;
    const ball = this.w.ball;
    const incoming = this.incomingTo(s.team);
    const preview = incoming && this.ownsBall(s) && !p.swing ? findContact(p, this.query(1.6), ball.flight) : null;
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
      if (swing.note) this.w.hud.tag(swing.note, 'bad', overHead(p));
      if (contact && this.doubles) {
        // You called it: your partner backs off.
        this.owner[s.team] = { flight: ball.flight, seat: s.index };
        const partner = this.partnerOf(s);
        if (partner?.player.swing && !partner.player.swing.resolved && partner.player.swing.contact?.flight === ball.flight) {
          partner.player.swing = null;
        }
      }
    }
  }

  private updateAi(s: Seat, ai: AiPlayer, time: number, dt: number): void {
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
    const swing = ai.update(this.aiContext(s, time));
    if (swing && p.canSwing(time)) p.swing = beginSwing(swing.button, time, swing.contact, { kind: swing.kind });
  }

  private aiContext(s: Seat, time: number): AiContext {
    return {
      time,
      ball: this.w.ball,
      path: this.path,
      bouncesSinceHit: this.bouncesSinceHit,
      incoming: this.incomingTo(s.team),
      opponents: this.teams[otherTeam(s.team)].map((o) => o.player),
      hitCount: this.referee.hitCount,
      mustLetBounce: this.referee.mustLetBounce,
      servingTeam: s.team === this.score.servingTeam,
      isReceiver: s === this.receiverSeat,
      canPlay: this.ownsBall(s),
      homeX: this.doubles ? courtX(s.player.side, this.rotation.courtOf(s.team, s.index)) * 0.9 : undefined,
    };
  }

  fixedUpdate(dt: number, time: number): void {
    const { ball } = this.w;
    for (const s of this.seats) {
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

      const canHit =
        this.phase === 'rally' && ball.inPlay && ball.flight === sw.contact.flight && this.lastHitter?.team !== s.team;
      if (!canHit) continue;
      const reach = reachAtContact(p);
      if (reach === 'miss') {
        if (s.human) this.w.hud.tag('Too far!', 'bad', overHead(p));
        continue;
      }
      if (reach === 'stretch' && sw.timing) {
        sw.timing = stretchTiming(sw.timing);
        if (s.human) this.w.hud.tag('Stretch!', 'bad', overHead(p));
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
    if (this.doubles) for (const team of this.teams) this.keepApart(team[0].player, team[1].player);
  }

  /** Partners don't run through each other. */
  private keepApart(a: Player, b: Player): void {
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d >= PARTNER_SPACING || d < 1e-6) return;
    const push = (PARTNER_SPACING - d) / 2;
    a.pos.x -= (dx / d) * push;
    a.pos.z -= (dz / d) * push;
    b.pos.x += (dx / d) * push;
    b.pos.z += (dz / d) * push;
  }

  private afterHit(s: Seat, time: number): void {
    this.lastHitter = s;
    this.bouncesSinceHit = 0;
    for (const other of this.teams[otherTeam(s.team)]) {
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
      this.w.hud.tag('Net cord!', 'info', new Vector3(e.x, 4, 0));
    } else if (e.type === 'bounce') {
      this.bouncesSinceHit++;
      if (this.bouncesSinceHit === 1 && this.lastHitter) {
        this.markers.add(e.x, e.z, isInCourt(e.x, e.z) && sideOf(e.z) !== this.lastHitter.player.side);
      }
      const f = this.referee.onBounce(e.x, e.z);
      if (f) this.endRally(f);
    }
  }

  describe(): string {
    if (this.watching) {
      return `
        <div class="title">Kitchen Clash <small>Watching AI vs AI${this.doubles ? ' · Doubles' : ''}</small></div>
        <div class="big">${this.teamNames[0]} vs ${this.teamNames[1]}</div>
        <div><b>F</b> Fast-forward · <b>T</b> Slow-mo</div>`;
    }
    const you = this.you;
    const yourServe = this.phase === 'preServe' && you && this.server === you;
    const hint = yourServe ? '<div class="big ok">Your serve! J = hard serve · K = safe serve (aim with A/D)</div>' : '';
    const partner = this.doubles && you ? '<div class="dim">Doubles: your teal partner covers the other half</div>' : '';
    return `
      <div class="title">Kitchen Clash <small>vs ${this.teamNames[1]}${this.doubles ? ' · Doubles' : ''}</small></div>
      <div><b>WASD</b> move + <b>J</b> <b>K</b> hit &nbsp;·&nbsp; or <b>Arrows</b> move + <b>Z</b> <b>X</b> hit</div>
      <div><b>J</b> Drive · dink · smash &nbsp; <b>K</b> Soft · drop · reset · lob</div>
      ${partner}${hint}
      <hr/>
      <div>Last shot: ${this.lastShot}</div>`;
  }

  cameraTargetX(): number {
    return this.you?.player.pos.x ?? this.w.ball.pos.x;
  }

  private query(maxTime: number) {
    return { path: this.path, bouncesSoFar: this.bouncesSinceHit, maxTime, slack: HUMAN_REACH };
  }

  private onGoodHit(s: Seat, report: ShotReport): void {
    if (!s.human) return;
    const g = GRADE_TEXT[report.timing.grade];
    if (report.timing.grade === 'perfect') {
      this.perfects++;
      this.w.fx?.burst(this.w.ball.pos, 1, true);
      // A Perfect put-away gets a tiny freeze-frame and a camera kick.
      if (report.kind === 'smash' || report.mph > 40) {
        this.w.fx?.hitstop(0.07);
        this.w.fx?.shake(0.5);
      }
    }
    if (s.player.contactGap() <= LUNGE_REACH) this.w.hud.tag(g.text, g.kind, overHead(s.player));
    this.lastShot = `${SHOT_NAMES[report.kind]} · ${report.mph.toFixed(0)} mph · ${g.text}`;
  }

  /** A fault ends the rally: score it, explain it, and set up the next serve (or end the game). */
  private endRally(fault: Fault): void {
    if (this.phase !== 'rally') return;
    this.phase = 'pointOver';
    this.phaseTimer = BETWEEN_POINTS;
    const loser: Team = teamOfSide(fault.side);
    const winner = otherTeam(loser);
    const shots = this.referee.hitCount;
    this.longestRally = Math.max(this.longestRally, shots);
    this.ralliesWon[winner]++;
    const humanWon = this.teams[winner].some((s) => s.human);
    const humanLost = this.teams[loser].some((s) => s.human);
    // The crowd reacts more to long rallies and to your points.
    const excitement = Math.min(1, 0.35 + shots / 14 + (humanWon ? 0.3 : 0));
    this.w.crowd?.cheer(excitement);
    this.w.audio?.play('cheer', { volume: 0.25 + 0.55 * excitement });

    const servingBefore = this.score.servingTeam;
    const outcome = this.score.rallyWonBy(winner);
    this.rotation.afterRally(servingBefore, outcome);
    const text = FAULT_TEXT[fault.reason];
    const who = humanLost ? (this.doubles ? 'Your team' : 'You') : this.teamNames[loser];
    const result =
      outcome.pointTo !== null
        ? `Point ${this.teams[outcome.pointTo].some((s) => s.human) ? (this.doubles ? 'your team' : 'you') : this.teamNames[outcome.pointTo]}!`
        : outcome.sideOut
          ? 'Side out!'
          : 'Second server';
    const good = this.watching ? true : !humanLost;
    this.w.hud.flash(text.title, good ? 'good' : 'bad', 2000, `${who}: ${text.detail} · ${result}`);
    this.log.push(`${fault.reason}:${loser}:${servingBefore === loser ? 'server' : 'receiver'}`);
    this.scoreboard?.update(this.score);

    const w = this.score.winner();
    if (w !== null) {
      this.phase = 'gameOver';
      this.phaseTimer = 4;
      const [a, b] = [this.score.points[w], this.score.points[otherTeam(w)]];
      this.log.push(`game:${w}:${a}-${b}`);
      this.w.crowd?.cheer(1);
      for (const s of this.teams[w]) s.player.celebrateAt = performance.now();
      if (this.watching) {
        setTimeout(() => this.w.hud.flash(`${this.teamNames[w]} WIN${this.doubles ? '' : 'S'}`, 'good', 2500, `${a} – ${b}`), 1200);
      } else {
        const result: MatchResult = {
          winner: w,
          names: this.teamNames,
          points: [this.score.points[0], this.score.points[1]],
          longestRally: this.longestRally,
          perfects: this.perfects,
          ralliesWon: [...this.ralliesWon] as [number, number],
          humanTeam: this.teams[0].some((s) => s.human),
        };
        setTimeout(() => this.onGameOver?.(result), 1500);
      }
    } else if (this.score.gamePointFor() !== null) {
      setTimeout(() => this.w.hud.flash('GAME POINT', 'info', 1200), 1000);
    }
  }
}
