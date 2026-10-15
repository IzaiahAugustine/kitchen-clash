import type { Object3D } from 'three';
import type { GameMode, World } from '../game/mode';
import { MatchMode, type MatchResult } from '../game/matchMode';
import type { BallEvent } from '../physics/ball';
import type { Player } from '../players/player';
import type { ShotButton, ShotKind, ShotPlan, Timing } from '../players/shots';
import { Vector3 } from 'three';
import type { ScoreConfig } from '../rules/scoring';
import type { Scoreboard } from '../ui/scoreboard';
import type { Channel } from './channel';
import { netStats } from './stats';

/** Snapshots per second: direct connections can take a lot; Firebase relay less. */
const SNAP_RATE = { p2p: 30, relay: 20, loopback: 30 };

/** A player's swing, as the guest needs it to animate (times are host game time). */
export interface SwingDesc {
  b: ShotButton;
  k: string;
  hand: 'fore' | 'back';
  s: number;
  c: number;
  e: number;
  cp: [number, number, number];
  cr: number;
}

export function swingDesc(p: Player): SwingDesc | null {
  const sw = p.swing;
  if (!sw || !sw.contact) return null;
  const c = sw.contact.pos;
  return { b: sw.button, k: sw.kind, hand: sw.hand, s: sw.startAt, c: sw.contactAt, e: sw.endAt, cp: [c.x, c.y, c.z], cr: sw.contact.crouch };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** A shot plan as numbers for the network: target x/z, flight time, spin x/y/z, net clearance. */
export function encodePlan(p: ShotPlan): (number | null)[] {
  return [p.target.x, p.target.z, p.flightTime, p.spin.x, p.spin.y, p.spin.z, p.clearance ?? null];
}

export function decodePlan(a: (number | null)[]): ShotPlan {
  return {
    target: new Vector3(a[0] ?? 0, 0, a[1] ?? 0),
    flightTime: a[2] ?? 1,
    spin: new Vector3(a[3] ?? 0, a[4] ?? 0, a[5] ?? 0),
    clearance: a[6] ?? undefined,
  };
}

/**
 * Online match, host side: runs the real match (ball, rules, score) with the friend in the
 * far seat, takes their position and presses from the network, and streams snapshots and
 * events back to them.
 */
export class OnlineHost implements GameMode {
  readonly match: MatchMode;
  readonly online = true;
  private sinceSnap = 0;
  /** Set by the game: the friend left or the connection dropped. */
  onGone: () => void = () => {};

  constructor(
    private w: World,
    template: Object3D | null,
    scoreboard: Scoreboard | null,
    private channel: Channel,
    hostName: string,
    guestName: string,
    scoring: ScoreConfig,
    private venue = 'park',
  ) {
    this.match = new MatchMode(w, template, scoreboard, {
      scoring: { ...scoring, teamSize: 1 },
      near: 'human',
      far: 'remote',
      names: ['YOU', guestName.toUpperCase().slice(0, 14)],
    });
    const send = (msg: object) => channel.send(msg, true);
    this.match.listener = {
      serveSetup: (i) => {
        send({ t: 'score', ...this.scoreState() });
        send({
          t: 'setup',
          serverTeam: i.serverTeam,
          call: i.call,
          pos: i.positions,
          serverPos: [i.setup.serverPos.x, i.setup.serverPos.z],
          receiverPos: [i.setup.receiverPos.x, i.setup.receiverPos.z],
          boxSide: i.setup.boxSide,
        });
      },
      rallyEnd: (i) => {
        send({ t: 'score', ...this.scoreState() });
        send({
          t: 'rally',
          reason: i.fault.reason,
          loser: i.loser,
          pointTo: i.outcome.pointTo,
          sideOut: i.outcome.sideOut,
          shots: i.shots,
        });
      },
      hit: (i) => send({ t: 'hit', ...i }),
      gameOver: (r: MatchResult) => send({ t: 'over', result: { ...r, names: [hostName, 'YOU'] } }),
    };
    this.hostName = hostName;
    this.scoring = scoring;
    // Last: attaching the handler can deliver messages that arrived early (the guest's 'ready').
    channel.onMessage = (m) => this.receive(m);
    channel.onClose = () => this.onGone();
  }

  private hostName: string;
  private scoring: ScoreConfig;

  private scoreState() {
    const s = this.match.currentScore;
    return { points: [...s.points], servingTeam: s.servingTeam, serverNumber: s.serverNumber, mode: s.cfg.mode, target: s.cfg.target };
  }

  private receive(m: Record<string, unknown>): void {
    netStats.hostMsgs++;
    const remote = this.match.remoteInput;
    switch (m.t) {
      case 'in':
        if (remote) {
          remote.pos = { x: m.x as number, z: m.z as number };
          remote.vel = { x: m.vx as number, z: m.vz as number };
          remote.lag = (m.lag as number) ?? 0;
        }
        break;
      case 'press':
        remote?.presses.push({
          button: m.b as ShotButton,
          lead: m.lead as number,
          aim: { x: m.ax as number, y: m.ay as number },
          at: typeof m.at === 'number' ? m.at : undefined,
          plan: Array.isArray(m.p) ? decodePlan(m.p as (number | null)[]) : undefined,
          kind: typeof m.k === 'string' ? (m.k as ShotKind) : undefined,
          timing: typeof m.tg === 'string' ? { grade: m.tg as Timing['grade'], error: m.te as number } : undefined,
        });
        break;
      case 'ready':
        // The friend's game is listening: start the match for real (once; they may repeat it).
        this.channel.send({ t: 'hello', hostName: this.hostName, scoring: this.scoring, venue: this.venue }, true);
        if (this.started) break;
        this.started = true;
        console.info('[KC] host: guest is ready, starting the match');
        this.match.newGame();
        break;
      case 'ping':
        if (!this.pinged) console.info('[KC] host: ping from guest');
        this.pinged = true;
        this.channel.send({ t: 'pong', c: m.c, h: this.now }, true);
        break;
      case 'bye':
        this.onGone();
        break;
    }
  }

  private now = 0;
  private pinged = false;
  private started = false;

  /** Host chose Rematch. */
  rematch(): void {
    this.match.newGame();
    this.channel.send({ t: 'newgame' }, true);
  }

  leave(): void {
    this.channel.send({ t: 'bye' }, true);
  }

  update(dt: number, time: number): void {
    this.now = time;
    this.match.update(dt, time);
    this.sinceSnap += dt;
    if (this.sinceSnap >= 1 / SNAP_RATE[this.channel.kind]) {
      this.sinceSnap = 0;
      this.sendSnapshot(time);
    }
  }

  private sendSnapshot(time: number): void {
    const b = this.w.ball;
    const st = this.match.netState();
    const host = st.players[0];
    this.channel.send(
      {
        t: 'snap',
        h: time,
        b: [b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z, b.spin.x, b.spin.y, b.spin.z].map((v) => Math.round(v * 1000) / 1000),
        f: b.flight,
        ip: b.inPlay ? 1 : 0,
        r: b.rolling ? 1 : 0,
        ph: st.phase,
        lh: st.lastHitterTeam,
        bc: st.bounces,
        mlb: st.mustLetBounce ? 1 : 0,
        hp: [r2(host.pos.x), r2(host.pos.z), r2(host.vel.x), r2(host.vel.z)],
        sw: swingDesc(host),
      },
      false,
    );
  }

  fixedUpdate(dt: number, time: number): void {
    this.now = time;
    this.match.fixedUpdate(dt, time);
  }

  onBallEvent(e: BallEvent, time: number): void {
    this.match.onBallEvent(e);
    void time;
  }

  describe(): string {
    return this.match.describe() + `<div class="dim">Online · ${this.channel.kind === 'p2p' ? 'direct connection' : 'relayed connection'}</div>`;
  }

  cameraTargetX(): number {
    return this.match.cameraTargetX();
  }

  dispose(): void {
    this.match.dispose();
  }
}
