import { Vector3, type Object3D } from 'three';
import type { GameMode, World } from '../game/mode';
import type { MatchResult } from '../game/matchMode';
import { COURT, type Side } from '../game/court';
import { Ball } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { predictPath, type PathSample } from '../physics/predict';
import { strikeGeometry } from '../players/body';
import { MAX_EARLY_LEAD, beginSwing, chooseHumanContact, executeShot, findContact } from '../players/hitting';
import { HumanController } from '../players/humanController';
import { PALETTES } from '../players/palette';
import { Player, type Swing } from '../players/player';
import { PlayerView } from '../players/playerView';
import { SHOT_NAMES, planShot, spinStreakTiming, type ShotButton, type ShotKind } from '../players/shots';
import { buildSwingPoses, styleFor } from '../players/swingPoses';
import { FAULT_TEXT, type FaultReason } from '../rules/referee';
import { DEFAULT_SCORING, Score, type ScoreConfig, type Team } from '../rules/scoring';
import { clampServer, type ServeSetup } from '../rules/serve';
import type { Scoreboard } from '../ui/scoreboard';
import type { Channel } from './channel';
import { decodePlan, encodePlan, type SwingDesc } from './onlineHost';
import { healthLine, netStats } from './stats';

/** How often we send our position (per second). */
const INPUT_RATE = { p2p: 30, relay: 20, loopback: 30 };
/** The host's player is drawn this far in the past, so there are always two snapshots to blend. */
const INTERP_DELAY = 0.03;
/** Draw the host up to this far (s) past their newest update, moving with their velocity. */
const MAX_EXTRAPOLATE = 0.3;
/** How long (s) our own hit is trusted before the host has to confirm it. */
const PREDICT_HOLD = 1.0;

const ME: Team = 1;
const HOST: Team = 0;
const overHead = (p: Player) => new Vector3(p.pos.x, 6.8, p.pos.z);
const GRADE = { perfect: ['Perfect!', 'good'], good: ['Nice!', 'info'], early: ['Early', 'bad'], late: ['Late', 'bad'] } as const;

interface HostSample {
  h: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/**
 * Online match, guest side. The host runs the real match; we show it from our end of the
 * court. Our own player moves instantly on our screen (and we report where we are); the ball
 * is simulated locally between snapshots so it flies smoothly, and corrected when they arrive.
 */
export class OnlineGuest implements GameMode {
  readonly online = true;
  private me: Player;
  private host: Player;
  private ctl: HumanController;
  private views: [Player, PlayerView][];
  private score: Score;
  private phase = 'preServe';
  private lastHitterTeam = -1;
  private bounces = 0;
  private mustLetBounce = false;
  private serverTeam: Team = 0;
  private setup: ServeSetup | null = null;
  private path: PathSample[] = [];
  private samples: HostSample[] = [];
  private hostSwingStart = -1;
  /** host game time ≈ our game time + offset */
  private offset = 0;
  private haveOffset = false;
  private rtt = 0.1;
  private pingIn = 0;
  private sinceInput = 0;
  private now = 0;
  private hostName = 'HOST';
  private scratch = new Ball();
  /** Set by the game. */
  onGameOver: ((r: MatchResult) => void) | null = null;
  onNewGame: () => void = () => {};
  onGone: () => void = () => {};
  /** The host's court (sent in 'hello'). */
  onVenue: (id: string) => void = () => {};

  constructor(
    private w: World,
    template: Object3D | null,
    private scoreboard: Scoreboard | null,
    private channel: Channel,
    hostName: string,
  ) {
    this.hostName = hostName;
    this.me = new Player('You', -1, PALETTES.rival);
    this.host = new Player(hostName, 1, PALETTES.hero);
    this.ctl = new HumanController(this.me);
    this.score = new Score(DEFAULT_SCORING, 0);
    this.views = template
      ? [this.host, this.me].map((p) => {
          const v = new PlayerView(template, p.palette);
          w.scene.add(v.root);
          return [p, v] as [Player, PlayerView];
        })
      : [];
    this.me.pos.set(-3.5, 0, -21.5);
    this.host.pos.set(3.5, 0, 23.2);
    scoreboard?.setNames([hostName.toUpperCase().slice(0, 14), 'YOU']);
    channel.onMessage = (m) => this.receive(m);
    channel.onClose = () => this.onGone();
    // Say we're ready until the host answers (a message can get lost while connecting).
    const sayReady = () => {
      if (this.gotHello) return;
      channel.send({ t: 'ready' }, true);
      this.readyTimer = setTimeout(sayReady, 1000);
    };
    sayReady();
    this.ping();
  }

  cameraSide(): Side {
    return -1;
  }

  private gotHello = false;
  private lastSnapAt = -Infinity;
  private friendFps: number | null = null;
  private drawnFrom = new Vector3();
  /** The host's next shot, known before it happens (their swing is sent at the press). */
  private hostShot: { at: number; flight: number; swing: Swing } | null = null;
  /** Flight number of our own predicted hit, and until when to trust it over older snapshots. */
  private predictedFlight = -1;
  private predictUntil = 0;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  leave(): void {
    clearTimeout(this.readyTimer);
    this.channel.send({ t: 'bye' }, true);
  }

  dispose(): void {
    clearTimeout(this.readyTimer);
    for (const [, v] of this.views) this.w.scene.remove(v.root);
    this.w.fx?.setLanding(null);
    this.w.fx?.setServeBox(null);
  }

  private ping(): void {
    this.channel.send({ t: 'ping', c: this.now }, true);
  }

  // ---------------------------------------------------------------- network

  private receive(m: Record<string, unknown>): void {
    switch (m.t) {
      case 'hello':
        this.gotHello = true;
        clearTimeout(this.readyTimer);
        this.hostName = m.hostName as string;
        this.score = new Score({ ...(m.scoring as ScoreConfig), teamSize: 1 }, 0);
        this.scoreboard?.setNames([this.hostName.toUpperCase().slice(0, 14), 'YOU']);
        if (typeof m.venue === 'string') this.onVenue(m.venue);
        break;
      case 'pong': {
        const rtt = Math.max(0, this.now - (m.c as number));
        this.rtt = this.haveOffset ? this.rtt * 0.8 + rtt * 0.2 : rtt;
        const offset = (m.h as number) + rtt / 2 - this.now;
        this.offset = this.haveOffset ? this.offset * 0.8 + offset * 0.2 : offset;
        this.haveOffset = true;
        break;
      }
      case 'snap':
        this.onSnapshot(m);
        if (++this.snaps % 150 === 0) console.info(`[KC] guest: ${this.snaps} snapshots, ping ${Math.round(this.rtt * 1000)} ms, score ${this.score.points.join('-')}, phase ${this.phase}`);
        break;
      case 'score': {
        const s = this.score;
        s.points[0] = (m.points as number[])[0];
        s.points[1] = (m.points as number[])[1];
        s.servingTeam = m.servingTeam as Team;
        s.serverNumber = m.serverNumber as 1 | 2;
        this.scoreboard?.update(s);
        break;
      }
      case 'setup':
        this.onSetup(m);
        break;
      case 'rally':
        this.onRally(m);
        break;
      case 'hit':
        this.onHit(m);
        break;
      case 'over': {
        const r = m.result as MatchResult;
        this.w.crowd?.cheer(1);
        setTimeout(() => this.onGameOver?.({ ...r, youTeam: ME, humanTeam: true }), 1500);
        break;
      }
      case 'newgame':
        this.onNewGame();
        break;
      case 'bye':
        this.onGone();
        break;
    }
  }

  private onSetup(m: Record<string, unknown>): void {
    this.phase = 'preServe';
    this.serverTeam = m.serverTeam as Team;
    const pos = m.pos as { x: number; z: number }[];
    this.me.swing = null;
    this.me.vel.set(0, 0, 0);
    this.me.pos.set(pos[1].x, 0, pos[1].z);
    this.samples = [];
    this.host.pos.set(pos[0].x, 0, pos[0].z);
    const sp = m.serverPos as number[];
    const rp = m.receiverPos as number[];
    this.setup = {
      serverPos: new Vector3(sp[0], 0, sp[1]),
      receiverPos: new Vector3(rp[0], 0, rp[1]),
      boxSide: m.boxSide as number,
    };
    const who = this.serverTeam === ME ? 'Your serve' : `${this.hostName} serves`;
    console.info(`[KC] guest got serve setup: ${m.call} (${who})`);
    this.w.hud.flash(m.call as string, 'info', 1400, who);
  }

  private onRally(m: Record<string, unknown>): void {
    const loser = m.loser as Team;
    const youLost = loser === ME;
    const pointTo = m.pointTo as Team | null;
    const text = FAULT_TEXT[m.reason as FaultReason];
    const who = youLost ? 'You' : this.hostName;
    const result = pointTo !== null ? `Point ${pointTo === ME ? 'you' : this.hostName}!` : 'Side out!';
    this.w.hud.flash(text.title, youLost ? 'bad' : 'good', 2000, `${who}: ${text.detail} · ${result}`);
    const shots = m.shots as number;
    const excitement = Math.min(1, 0.35 + shots / 14 + (youLost ? 0 : 0.3));
    this.w.crowd?.cheer(excitement);
    this.phase = 'pointOver';
  }

  private onHit(m: Record<string, unknown>): void {
    if (m.team !== ME) return;
    const grade = m.grade as keyof typeof GRADE;
    const [text, kind] = GRADE[grade];
    const label = m.low ? 'Popped it up!' : m.spun && grade === 'perfect' ? (m.kind === 'roll' ? 'ROLLED IT!' : 'SLICED!') : text;
    this.w.hud.tag(label, kind, overHead(this.me));
    if (grade === 'perfect') {
      this.w.fx?.burst(this.w.ball.pos, 1, true);
      if (m.spun || m.kind === 'smash') this.w.fx?.shake(0.5);
    }
    this.lastShot = `${SHOT_NAMES[m.kind as ShotKind] ?? m.kind} · ${(m.mph as number).toFixed(0)} mph · ${text}`;
  }

  private lastShot = '—';
  private snaps = 0;

  /** Ball: re-simulate from the snapshot to "now" and blend toward it, or snap on a new shot. */
  private onSnapshot(m: Record<string, unknown>): void {
    // Snapshots travel on the fast, unordered channel: an older one arriving late would yank
    // the ball backward, so only use the newest.
    if ((m.h as number) <= this.lastSnapAt) return;
    this.lastSnapAt = m.h as number;
    netStats.snaps++;
    if (typeof m.fp === 'number') this.friendFps = m.fp;
    // We just hit the ball ourselves: snapshots from before the host saw that hit would pull
    // the ball back onto its old path. Use them for the host's position only.
    if ((m.f as number) < this.predictedFlight && this.now < this.predictUntil) {
      const hp = m.hp as number[];
      this.samples.push({ h: m.h as number, x: hp[0], z: hp[1], vx: hp[2], vz: hp[3] });
      if (this.samples.length > 20) this.samples.shift();
      netStats.heldForPrediction++;
      return;
    }
    this.phase = m.ph as string;
    this.lastHitterTeam = m.lh as number;
    this.bounces = m.bc as number;
    this.mustLetBounce = m.mlb === 1;
    const age = this.haveOffset ? Math.max(0, Math.min(0.5, this.now + this.offset - (m.h as number))) : this.rtt / 2;
    netStats.ageSum += age;
    const b = m.b as number[];
    const ball = this.w.ball;
    const s = this.scratch;
    if (m.ip === 1) {
      s.launch(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]), new Vector3(b[6], b[7], b[8]));
      s.rolling = m.r === 1;
      for (let t = 0; t < age && s.inPlay; t += PHYS.fixedDt) s.step(PHYS.fixedDt);
      s.drainEvents();
      const newShot = (m.f as number) !== ball.flight || !ball.inPlay;
      const err = s.pos.distanceTo(ball.pos);
      const was = this.drawnFrom.copy(ball.pos);
      const wasInPlay = ball.inPlay;
      if (!newShot && err > 1.2) netStats.snapJumps++;
      if (newShot || err > 1.2) {
        ball.launch(s.pos, s.vel, s.spin);
        ball.rolling = s.rolling;
        ball.flight = m.f as number;
        if (wasInPlay) this.w.ballView.smoothJump?.(was, ball.pos);
      } else {
        ball.pos.lerp(s.pos, 0.35);
        ball.vel.lerp(s.vel, 0.35);
      }
    } else {
      ball.hold(new Vector3(b[0], b[1], b[2]));
      ball.flight = m.f as number;
    }

    const hp = m.hp as number[];
    this.samples.push({ h: m.h as number, x: hp[0], z: hp[1], vx: hp[2], vz: hp[3] });
    if (this.samples.length > 20) this.samples.shift();

    const sw = m.sw as SwingDesc | null;
    if (sw && sw.s !== this.hostSwingStart) {
      this.hostSwingStart = sw.s;
      this.host.swing = this.rebuildSwing(sw);
      // Their shot is already decided: play it on our screen right at their contact time.
      if (sw.p && sw.f !== undefined) {
        const swing = this.rebuildSwing(sw);
        swing.plan = decodePlan(sw.p);
        this.hostShot = { at: sw.c - this.offset, flight: sw.f, swing };
      }
    }
  }

  /** Recreate the host's swing locally so their animation matches (times moved onto our clock). */
  private rebuildSwing(d: SwingDesc): Swing {
    const off = this.offset;
    const p = this.host;
    const cp = new Vector3(d.cp[0], d.cp[1], d.cp[2]);
    const dx = cp.x - p.pos.x;
    const dz = cp.z - p.pos.z;
    const local = new Vector3(dx * p.right.x + dz * p.right.z, cp.y, -(dx * p.forward.x + dz * p.forward.z));
    const kind = d.k as ShotKind;
    return {
      button: d.b,
      kind,
      hand: d.hand,
      startAt: d.s - off,
      contactAt: d.c - off,
      endAt: d.e - off,
      contact: null,
      timing: null,
      poses: buildSwingPoses(styleFor(kind), d.hand, local, d.cr),
      resolved: true,
    };
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, time: number): void {
    this.now = time;
    const ball = this.w.ball;
    this.path = predictPath(ball, 1.8, this.path);
    const me = this.me;

    this.pingIn -= dt;
    if (this.pingIn <= 0) {
      this.pingIn = 1;
      this.ping();
    }

    const incoming = this.phase === 'rally' && this.lastHitterTeam !== ME;
    const q = (maxTime: number) => ({ path: this.path, bouncesSoFar: this.bounces, maxTime, slack: 2.6 });
    const preview = incoming && !me.swing ? findContact(me, q(1.6), ball.flight) : null;
    const button = this.ctl.update(this.w.controls.frame, preview);
    if (button) this.press(button, time, incoming, q);

    if (this.phase === 'preServe' && this.serverTeam === ME && this.setup && !me.swing) clampServer(me, this.setup);

    this.sinceInput += dt;
    if (this.sinceInput >= 1 / INPUT_RATE[this.channel.kind]) {
      this.sinceInput = 0;
      this.channel.send({ t: 'in', x: me.pos.x, z: me.pos.z, vx: me.vel.x, vz: me.vel.z, lag: this.rtt / 2, fp: Math.round(netStats.fps) }, false);
    }

    this.placeHost(time);
    this.guides(incoming);
    for (const [p, v] of this.views) v.update(p, time, dt, ball.pos);
  }

  private press(button: ShotButton, time: number, incoming: boolean, q: (t: number) => Parameters<typeof findContact>[1]): void {
    const me = this.me;
    const aim = this.ctl.aim;
    if (this.phase === 'preServe' && this.serverTeam === ME) {
      if (me.swing) return;
      // The host serves for us; we just animate the underhand swing.
      const g = strikeGeometry(1.8, 'fore');
      const hold = new Vector3(me.pos.x + me.right.x * g.lateral, 1.8, me.pos.z + me.forward.z * g.forward);
      me.swing = beginSwing(
        button,
        time,
        { t: 0.5, pos: hold, hand: 'fore', standAt: me.pos.clone(), crouch: g.crouch, flight: -1, bounced: true },
        { kind: 'serve', feed: true, timing: { grade: 'good', error: 0 } },
      );
      this.channel.send({ t: 'press', b: button, lead: -1, ax: aim.x, ay: aim.y }, true);
      return;
    }
    if (this.phase !== 'rally' || !me.canSwing(time)) return;
    const contact = incoming ? chooseHumanContact(me, q(MAX_EARLY_LEAD + 0.3), this.w.ball.flight, this.mustLetBounce) : null;
    const swing = beginSwing(button, time, contact);
    me.swing = swing;
    if (swing.note) this.w.hud.tag(swing.note, 'bad', overHead(me));
    // Decide the shot now, on our screen, so we can play it the instant we make contact
    // instead of waiting a round trip for the host. The host plays the exact same shot.
    if (swing.contact && swing.timing) {
      const ball = this.w.ball;
      const spun = button === 'spin';
      if (spun) swing.timing = spinStreakTiming(swing.timing, me.spinStreak);
      swing.plan = planShot(swing.kind as ShotKind, swing.contact.pos, me.side, swing.hand, aim, swing.timing, spun, {
        incomingSpeed: ball.vel.length(),
        hitterSpeed: Math.hypot(me.vel.x, me.vel.z),
        towardNet: -me.side * me.vel.z,
        volley: !swing.contact.bounced,
      });
    }
    if (incoming) {
      this.channel.send(
        {
          t: 'press',
          b: button,
          k: swing.contact ? swing.kind : undefined,
          tg: swing.contact ? swing.timing?.grade : undefined,
          te: swing.contact ? swing.timing?.error : undefined,
          p: swing.plan ? encodePlan(swing.plan) : undefined,
          lead: contact ? contact.t : -1,
          // When we'll hit it, in the host's clock (our ball is already synced to "host now").
          at: contact && this.haveOffset ? time + this.offset + contact.t : undefined,
          ax: aim.x,
          ay: aim.y,
        },
        true,
      );
    }
  }

  /** Draw the host slightly in the past, blending between snapshots. */
  private placeHost(time: number): void {
    const rt = time + this.offset - INTERP_DELAY;
    const s = this.samples;
    if (!s.length) return;
    const last = s[s.length - 1];
    if (rt >= last.h) {
      // Updates are ~a tenth of a second old by the time they arrive: carry them forward.
      const ahead = Math.min(rt - last.h, MAX_EXTRAPOLATE);
      this.host.pos.x = last.x + last.vx * ahead;
      this.host.pos.z = last.z + last.vz * ahead;
      this.host.vel.set(last.vx, 0, last.vz);
      if (this.host.swing && time > this.host.swing.endAt + 0.3) this.host.swing = null;
      return;
    }
    let a = s[0];
    let b = s[s.length - 1];
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i].h <= rt && s[i + 1].h >= rt) {
        a = s[i];
        b = s[i + 1];
        break;
      }
    }
    const span = b.h - a.h;
    const k = span > 1e-6 ? Math.max(0, Math.min(1, (rt - a.h) / span)) : 1;
    this.host.pos.x = a.x + (b.x - a.x) * k;
    this.host.pos.z = a.z + (b.z - a.z) * k;
    this.host.vel.set(a.vx + (b.vx - a.vx) * k, 0, a.vz + (b.vz - a.vz) * k);
    if (this.host.swing && time > this.host.swing.endAt + 0.3) this.host.swing = null;
  }

  private guides(incoming: boolean): void {
    const fx = this.w.fx;
    if (!fx) return;
    let landing: Vector3 | null = null;
    if (incoming && this.bounces === 0) {
      const s = this.path.find((p) => p.bounces >= 1);
      if (s && s.z < 0) landing = new Vector3(s.x, 0, s.z);
    }
    fx.setLanding(landing);
    const serving = this.phase === 'preServe' && this.serverTeam === ME && !this.me.swing && this.setup;
    fx.setServeBox(
      serving ? { x0: 0, x1: this.setup!.boxSide * COURT.halfWidth, z0: COURT.kitchenDepth, z1: COURT.halfLength } : null,
    );
  }

  fixedUpdate(dt: number, time: number): void {
    const me = this.me;
    me.step(dt, time);
    const hs = this.hostShot;
    if (hs && time >= hs.at) {
      this.hostShot = null;
      const ball = this.w.ball;
      if (ball.inPlay && ball.flight === hs.flight && this.phase === 'rally' && this.lastHitterTeam === ME) {
        executeShot(ball, this.host, hs.swing, { x: 0, y: 0 });
        this.predictedFlight = ball.flight;
        this.predictUntil = time + PREDICT_HOLD;
        this.lastHitterTeam = HOST;
        this.bounces = 0;
      }
    }
    const sw = me.swing;
    if (!sw || sw.resolved || time < sw.contactAt) return;
    sw.resolved = true;
    // Our own hit: send the ball off right now (the host plays the same shot and confirms it).
    const ball = this.w.ball;
    if (!sw.plan || !sw.contact || !ball.inPlay || ball.flight !== sw.contact.flight || this.phase !== 'rally') return;
    if (this.lastHitterTeam === ME) return;
    executeShot(ball, me, sw, this.ctl.aim);
    this.predictedFlight = ball.flight;
    this.predictUntil = time + PREDICT_HOLD;
    this.lastHitterTeam = ME;
    this.bounces = 0;
  }

  onBallEvent(): void {}

  describe(): string {
    const yourServe = this.phase === 'preServe' && this.serverTeam === ME;
    return `
      <div class="title">Kitchen Clash <small>Online vs ${this.hostName}</small></div>
      <div><b>WASD</b> move + <b>J</b> <b>K</b> <b>L</b> hit &nbsp;·&nbsp; or <b>Arrows</b> + <b>Z</b> <b>X</b> <b>C</b></div>
      ${yourServe ? '<div class="big ok">Your serve! J = hard · K = safe · L = spin</div>' : ''}
      <hr/>
      <div>Last shot: ${this.lastShot}</div>
      <div class="dim">Online · ${this.channel.kind === 'p2p' ? 'direct connection' : 'relayed connection'}</div>
      ${healthLine(this.haveOffset ? this.rtt * 1000 : null, this.friendFps)}`;
  }

  cornerText(): string {
    return healthLine(this.haveOffset ? this.rtt * 1000 : null, this.friendFps);
  }

  yourServe(): boolean {
    return this.phase === 'preServe' && this.serverTeam === ME;
  }

  cameraTargetX(): number {
    return this.me.pos.x;
  }
}
