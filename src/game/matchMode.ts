import { Vector3, type Object3D } from 'three';
import { AiPlayer, type AiContext } from '../ai/aiPlayer';
import { PROFILES, type AiProfile, type Difficulty } from '../ai/difficulty';
import type { BallEvent } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { predictPath, type PathSample } from '../physics/predict';
import { strikeGeometry } from '../players/body';
import {
  MAX_EARLY_LEAD,
  beginSwing,
  gradeTiming,
  chooseHumanContact,
  contactAtPoint,
  contactAtTime,
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
import { SET_ZONE, SHOT_NAMES, planShot, spinStreakTiming, type Aim, type ShotButton, type ShotKind, type ShotPlan, type Timing } from '../players/shots';
import { BounceMarkers } from '../render/markers';
import { FAULT_TEXT, Referee, type Fault } from '../rules/referee';
import {
  DEFAULT_SCORING,
  Score,
  otherTeam,
  teamOfSide,
  type RallyOutcome,
  type ScoreConfig,
  type Team,
} from '../rules/scoring';
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

/**
 * Who plays a side: you (with an AI partner in doubles), a friend online ('remote', driven by
 * network input), or an AI at some difficulty.
 */
export type Controller = 'human' | 'remote' | Difficulty;

/** Input for a seat played by a friend online: their reported position plus queued presses. */
/** How late (s) a friend's hit may arrive and still be replayed from the moment they made it. */
const REWIND_WINDOW = 0.6;

export interface RemoteInput {
  pos: { x: number; z: number } | null;
  vel: { x: number; z: number };
  /** One-way network delay (s): their reports are this old by the time they arrive. */
  lag: number;
  /** `lead` = seconds to contact on THEIR screen when pressed (so lag doesn't spoil timing). */
  presses: {
    button: ShotButton;
    lead: number;
    aim: Aim;
    at?: number;
    /** The shot their screen already played (so both screens send the ball the same way). */
    plan?: ShotPlan;
    kind?: ShotKind;
    timing?: Timing;
  }[];
}

/** Key moments of a match, for sending to an online opponent. */
export interface MatchListener {
  serveSetup(info: { serverTeam: Team; call: string; positions: { x: number; z: number }[]; setup: ServeSetup }): void;
  rallyEnd(info: { fault: Fault; loser: Team; outcome: RallyOutcome; shots: number }): void;
  hit(info: { team: Team; kind: string; grade: string; mph: number; spun: boolean; low: boolean }): void;
  gameOver(result: MatchResult): void;
}

export interface MatchOptions {
  /** `teamSize` 1 = singles, 2 = doubles. */
  scoring: ScoreConfig;
  /** Near side (team 0). 'human' for you; a difficulty for AI vs AI. */
  near: Controller;
  /** Far side (team 1). */
  far: Controller;
  /** Override the scoreboard names (online: players' names). */
  names?: [string, string];
  /** Your look (near player, when it's you). */
  nearPalette?: Palette;
  /** Tournament rival: their look and personality. */
  farPalette?: Palette;
  farProfile?: AiProfile;
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
  /** Which team "you" were on (online guests are team 1). Defaults to 0. */
  youTeam?: Team;
}

/** One player slot on a team. */
interface Seat {
  team: Team;
  index: number;
  player: Player;
  human: HumanController | null;
  ai: AiPlayer | null;
  remote: RemoteInput | null;
}

const TEAM_PALETTES: [Palette[], Palette[]] = [
  [PALETTES.hero, PALETTES.partner],
  [PALETTES.rival, PALETTES.rival2],
];

const label = (c: Controller) =>
  c === 'human' ? 'YOU' : c === 'remote' ? 'FRIEND' : `CPU ${PROFILES[c].label.toUpperCase()}`;

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
  /** "Set at the net!" tips: shown a few times per match, once per rally at most. */
  private setTips = 0;
  private setThisRally = false;
  private ralliesWon: [number, number] = [0, 0];
  /** Called when a game with a human player ends (AI vs AI just starts a new game). */
  onGameOver: ((r: MatchResult) => void) | null = null;
  /** Online host: told about serves, hits, points and the end of the game. */
  listener: MatchListener | null = null;
  /** Online: the last half-second of ball states, so a friend's late-arriving hit can rewind. */
  private ballHistory: { t: number; pos: Vector3; vel: Vector3; spin: Vector3; rolling: boolean; flight: number; bounces: number }[] = [];
  /** Online: a "bounced twice" call on the friend's side, held briefly in case their hit is in the post. */
  private pendingFault: { fault: Fault; at: number } | null = null;
  private now = 0;

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
        const level: Difficulty = c === 'human' || c === 'remote' ? 'medium' : c;
        const partnerLevel: Difficulty = opts.far === 'human' || opts.far === 'remote' ? 'medium' : opts.far;
        const person = (c === 'human' || c === 'remote') && index === 0;
        const palette =
          team === 0 && index === 0 && c === 'human' && opts.nearPalette
            ? opts.nearPalette
            : team === 1 && index === 0 && opts.farPalette
              ? opts.farPalette
              : TEAM_PALETTES[team][index];
        const player = new Player(person ? 'You' : 'CPU', team === 0 ? 1 : -1, palette);
        return {
          team,
          index,
          player,
          human: person ? new HumanController(player) : null,
          ai: person
            ? null
            : new AiPlayer(player, team === 1 && index === 0 && opts.farProfile ? opts.farProfile : PROFILES[c === 'human' ? partnerLevel : level]),
          remote: c === 'remote' && index === 0 ? { pos: null, vel: { x: 0, z: 0 }, lag: 0, presses: [] } : null,
        };
      });
    this.teams = [make(0, opts.near), make(1, opts.far)];
    this.seats = [...this.teams[0], ...this.teams[1]];
    this.teamNames = opts.names ?? [size === 2 && opts.near === 'human' ? 'YOU + CPU' : label(opts.near), label(opts.far)];
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
    return !this.seats.some((s) => s.human && !s.remote);
  }

  private get you(): Seat | undefined {
    return this.seats.find((s) => s.human && !s.remote);
  }

  /** The remote (online) seat's input, for the host to fill from the network. */
  get remoteInput(): RemoteInput | null {
    return this.seats.find((s) => s.remote)?.remote ?? null;
  }

  /** What an online guest needs each snapshot. */
  netState() {
    return {
      phase: this.phase,
      lastHitterTeam: this.lastHitter?.team ?? -1,
      bounces: this.bouncesSinceHit,
      mustLetBounce: this.referee.mustLetBounce,
      score: this.score,
      players: this.seats.map((s) => s.player),
    };
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
    this.pendingFault = null;
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.setThisRally = false;
    for (const s of this.seats) {
      s.player.spinStreak = 0;
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
    this.listener?.serveSetup({
      serverTeam: server.team,
      call: this.score.call(),
      positions: this.seats.map((s) => ({ x: s.player.pos.x, z: s.player.pos.z })),
      setup: this.setup,
    });
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
    this.path = predictPath(ball, 1.8, this.path);

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
      if (s.remote) this.updateRemote(s, s.remote, time, dt);
      else if (s.human) this.updateHuman(s, s.human, time);
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
    // Teach "own the net" without a lesson: a quick tag the first few times you get set there.
    if (this.phase === 'rally' && !this.setThisRally && this.setTips < 3 && !s.remote && Math.abs(p.pos.z) <= SET_ZONE && Math.hypot(p.vel.x, p.vel.z) < 0.5) {
      this.setThisRally = true;
      this.setTips++;
      this.w.hud.tag('Set at the net!', 'good', overHead(p), 1100);
    }
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
      // Online: decide the shot now so the friend's screen can play it at the same instant.
      if (this.remoteInput && swing.contact && swing.timing) {
        const spun = button === 'spin';
        if (spun) swing.timing = spinStreakTiming(swing.timing, p.spinStreak);
        swing.plan = planShot(swing.kind as ShotKind, swing.contact.pos, p.side, swing.hand, ctl.aim, swing.timing, spun, {
          incomingSpeed: ball.vel.length(),
          hitterSpeed: Math.hypot(p.vel.x, p.vel.z),
          towardNet: -p.side * p.vel.z,
          volley: !swing.contact.bounced,
        });
      }
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

  /**
   * A friend playing online: their own screen moves them (we take its reported position), and
   * their presses arrive here. Timing is graded by when they pressed on THEIR screen.
   */
  private updateRemote(s: Seat, r: RemoteInput, time: number, dt: number): void {
    const p = s.player;
    if (r.pos) {
      // Lag compensation: they've kept moving since they sent this, so project it forward.
      const ahead = Math.min(r.lag, 0.25);
      const tx = Math.max(-15.5, Math.min(15.5, r.pos.x + r.vel.x * ahead));
      const tz = p.side * Math.max(0.8, Math.min(30, p.side * (r.pos.z + r.vel.z * ahead)));
      // Their updates arrive in uneven bursts: keep moving with their velocity and ease toward
      // the reported spot, so they glide instead of teleporting a step at a time.
      p.pos.x += r.vel.x * dt;
      p.pos.z += r.vel.z * dt;
      const k = 1 - Math.exp(-dt * 14);
      const far = Math.hypot(tx - p.pos.x, tz - p.pos.z) > 6;
      p.pos.x = far ? tx : p.pos.x + (tx - p.pos.x) * k;
      p.pos.z = far ? tz : p.pos.z + (tz - p.pos.z) * k;
      p.vel.set(r.vel.x, 0, r.vel.z);
    }
    if (p.swing && time > p.swing.endAt + 0.3) p.swing = null;
    const ball = this.w.ball;
    for (const press of r.presses.splice(0)) {
      s.human!.aim = press.aim;
      if (this.phase === 'preServe' && this.server === s && !p.swing) {
        this.serve(time, press.button, press.aim);
      } else if (this.phase === 'rally' && press.at !== undefined && time - press.at > 1e-3 && time - press.at <= REWIND_WINDOW) {
        this.rewindSwing(s, press, time);
      } else if (this.phase === 'rally' && p.canSwing(time) && this.incomingTo(s.team)) {
        // Hit at the moment their screen chose (sent in our clock), else pick one ourselves.
        const contact =
          (press.at !== undefined ? contactAtTime(p, this.path, press.at - time, this.bouncesSinceHit, ball.flight) : null) ??
          chooseHumanContact(p, this.query(MAX_EARLY_LEAD + 0.3), ball.flight, this.referee.mustLetBounce);
        const timing = press.timing ?? (contact && press.lead >= 0 ? gradeTiming(press.lead, press.button === 'spin') : undefined);
        p.swing = beginSwing(press.button, time, contact, { timing, kind: contact ? press.kind : undefined });
        if (contact && press.plan) p.swing.plan = press.plan;
      }
    }
  }

  /** A friend's hit that happened (on their screen) a moment ago: replay it from that moment. */
  private rewindSwing(s: Seat, press: RemoteInput['presses'][number], time: number): void {
    const ball = this.w.ball;
    let h = this.ballHistory[0];
    for (const e of this.ballHistory) if (Math.abs(e.t - press.at!) < Math.abs(h.t - press.at!)) h = e;
    const legal =
      h &&
      Math.abs(h.t - press.at!) < 0.02 &&
      h.flight === ball.flight &&
      this.incomingTo(s.team) &&
      s.player.side * h.pos.z >= 0.5 &&
      h.pos.y >= 0.4 &&
      h.bounces < 2;
    if (!legal) return;
    const contact = contactAtPoint(s.player, h.pos, h.bounces > 0, ball.flight);
    const swing = beginSwing(press.button, time, contact, {
      timing: press.timing ?? (press.lead >= 0 ? gradeTiming(press.lead, press.button === 'spin') : undefined),
      kind: press.kind,
    });
    if (press.plan) swing.plan = press.plan;
    swing.rewind = { pos: h.pos, vel: h.vel, spin: h.spin, rolling: h.rolling, bounces: h.bounces, ago: time - h.t };
    s.player.swing = swing;
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
    this.now = time;
    if (this.pendingFault && time >= this.pendingFault.at) {
      const f = this.pendingFault.fault;
      this.pendingFault = null;
      this.endRally(f);
    }
    if (this.remoteInput) {
      this.ballHistory.push({
        t: time,
        pos: ball.pos.clone(),
        vel: ball.vel.clone(),
        spin: ball.spin.clone(),
        rolling: ball.rolling,
        flight: ball.flight,
        bounces: this.bouncesSinceHit,
      });
      while (this.ballHistory.length && this.ballHistory[0].t < time - REWIND_WINDOW - 0.1) this.ballHistory.shift();
    }
    for (const s of this.seats) {
      const p = s.player;
      // An online friend's position comes from their own screen.
      if (!s.remote) p.step(dt, time);
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

      if (sw.rewind && this.phase === 'rally' && this.lastHitter?.team !== s.team) {
        this.playRewind(s, sw, time);
        continue;
      }
      const canHit =
        this.phase === 'rally' && ball.inPlay && ball.flight === sw.contact.flight && this.lastHitter?.team !== s.team;
      if (!canHit) continue;
      // A friend's own screen already judged its reach and played the shot: trust it.
      const reach = s.remote && sw.plan ? 'ok' : reachAtContact(p);
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
      this.listener?.hit({
        team: s.team,
        kind: report.kind,
        grade: report.timing.grade,
        mph: report.mph,
        spun: sw.button === 'spin',
        low: report.lowAttack > 0,
      });
      if (fault) this.endRally(fault);
      else this.onGoodHit(s, report);
    }
    if (this.doubles) for (const team of this.teams) this.keepApart(team[0].player, team[1].player);
  }

  /** Replay a late-arriving hit: put the ball back where it was, hit it, and catch up to now. */
  private playRewind(s: Seat, sw: Swing, time: number): void {
    const ball = this.w.ball;
    const rw = sw.rewind!;
    if (this.pendingFault) {
      // We were only waiting to call that double bounce: it never happened after all.
      this.pendingFault = null;
      this.referee.live = true;
    }
    const drawnAt = ball.pos.clone();
    ball.launch(rw.pos, rw.vel, rw.spin);
    ball.rolling = rw.rolling;
    ball.drainEvents();
    this.bouncesSinceHit = rw.bounces;
    const fault = this.referee.onHit(s.player.side, rw.bounces > 0, s.player.pos.z, time);
    const report = executeShot(ball, s.player, sw, s.human!.aim);
    this.afterHit(s, time);
    this.listener?.hit({
      team: s.team,
      kind: report.kind,
      grade: report.timing.grade,
      mph: report.mph,
      spun: sw.button === 'spin',
      low: report.lowAttack > 0,
    });
    if (fault) {
      this.endRally(fault);
      return;
    }
    for (let t = 0; t < rw.ago && ball.inPlay; t += PHYS.fixedDt) {
      ball.step(PHYS.fixedDt);
      for (const e of ball.drainEvents()) this.onBallEvent(e);
    }
    // Glide the drawn ball onto its replayed path instead of teleporting it.
    this.w.ballView.smoothJump?.(drawnAt, ball.pos);
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
      if (!f) return;
      // Online: hold a "bounced twice" call on the friend's side for a moment; their hit may be on its way.
      const remote = this.seats.find((s) => s.remote);
      if (f.reason === 'double-bounce' && remote && f.side === remote.player.side) {
        this.pendingFault = { fault: f, at: this.now + Math.min(0.4, remote.remote!.lag * 2 + 0.06) };
        return;
      }
      this.endRally(f);
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
    const hint = yourServe ? '<div class="big ok">Your serve! J = hard · K = safe · L = spin (aim with A/D)</div>' : '';
    const partner = this.doubles && you ? '<div class="dim">Doubles: your teal partner covers the other half</div>' : '';
    return `
      <div class="title">Kitchen Clash <small>vs ${this.teamNames[1]}${this.doubles ? ' · Doubles' : ''}</small></div>
      <div><b>WASD</b> move + <b>J</b> <b>K</b> <b>L</b> hit &nbsp;·&nbsp; or <b>Arrows</b> + <b>Z</b> <b>X</b> <b>C</b></div>
      <div><b>J</b> Drive · dink &nbsp; <b>K</b> Soft · drop · lob &nbsp; <b>L</b> Spin (hardest to time!)</div>
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
    if (!s.human || s.remote) return;
    const g = GRADE_TEXT[report.timing.grade];
    const spun = s.player.swing?.button === 'spin';
    if (report.timing.grade === 'perfect') {
      this.perfects++;
      this.w.fx?.burst(this.w.ball.pos, 1, true);
      // A Perfect put-away or spin shot gets a tiny freeze-frame and a camera kick.
      if (spun || report.kind === 'smash' || report.mph > 40) {
        this.w.fx?.hitstop(spun ? 0.09 : 0.07);
        this.w.fx?.shake(spun ? 0.6 : 0.5);
      }
    }
    const popped = report.lowAttack > 0;
    const label = popped ? 'Popped it up!' : spun && report.timing.grade === 'perfect' ? (report.kind === 'roll' ? 'ROLLED IT!' : 'SLICED!') : g.text;
    if (s.player.contactGap() <= LUNGE_REACH) this.w.hud.tag(label, g.kind, overHead(s.player));
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
    const humanWon = this.teams[winner].some((s) => s.human && !s.remote);
    const humanLost = this.teams[loser].some((s) => s.human && !s.remote);
    // The crowd reacts more to long rallies and to your points.
    const excitement = Math.min(1, 0.35 + shots / 14 + (humanWon ? 0.3 : 0));
    this.w.crowd?.cheer(excitement);
    this.w.audio?.play('cheer', { volume: 0.25 + 0.55 * excitement });

    const servingBefore = this.score.servingTeam;
    const outcome = this.score.rallyWonBy(winner);
    this.rotation.afterRally(servingBefore, outcome);
    this.listener?.rallyEnd({ fault, loser, outcome, shots });
    const text = FAULT_TEXT[fault.reason];
    const who = humanLost ? (this.doubles ? 'Your team' : 'You') : this.teamNames[loser];
    const result =
      outcome.pointTo !== null
        ? `Point ${this.teams[outcome.pointTo].some((s) => s.human && !s.remote) ? (this.doubles ? 'your team' : 'you') : this.teamNames[outcome.pointTo]}!`
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
          humanTeam: this.teams[0].some((s) => s.human && !s.remote),
        };
        this.listener?.gameOver(result);
        setTimeout(() => this.onGameOver?.(result), 1500);
      }
    } else if (this.score.gamePointFor() !== null) {
      setTimeout(() => this.w.hud.flash('GAME POINT', 'info', 1200), 1000);
    }
  }
}
