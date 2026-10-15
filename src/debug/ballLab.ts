import * as THREE from 'three';
import { isInCourt, type Side } from '../game/court';
import { hasDebugFlag } from '../game/debugFlags';
import type { GameMode, World } from '../game/mode';
import type { BallEvent } from '../physics/ball';
import { solveShot, topspin } from '../physics/trajectory';
import { BounceMarkers } from '../render/markers';

/**
 * Phase 1 test harness: fires preset shots so the ball physics can be checked by eye
 * before players exist.
 */

interface LabShot {
  from: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  netClearance: number | null;
}

interface Preset {
  key: string;
  keyLabel: string;
  label: string;
  /** Included in the random / auto-rally mix. */
  rally: boolean;
  /** `side` is the hitter's half: 1 = near (+z), -1 = far. */
  build(side: Side): LabShot;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function solved(from: THREE.Vector3, target: THREE.Vector3, time: number, spinRad: number, clearance?: number): LabShot {
  const spin = topspin(target.clone().sub(from), spinRad);
  const sol = solveShot({ from, target, flightTime: time, spin, minNetClearance: clearance });
  return { from, velocity: sol.velocity, spin, netClearance: sol.landing?.netClearance ?? null };
}

/** Bisects the arc height until the ball just clips the tape. */
function netCord(side: Side): LabShot {
  const from = V(rand(-4, 4), 1.8, 12 * side);
  const target = V(rand(-5, 5), 0, -rand(8, 14) * side);
  const spin = topspin(target.clone().sub(from), 10);
  let lo = 0.3;
  let hi = 1.6;
  let sol = solveShot({ from, target, flightTime: hi, spin });
  for (let i = 0; i < 22; i++) {
    const t = (lo + hi) / 2;
    sol = solveShot({ from, target, flightTime: t, spin });
    if ((sol.landing?.netClearance ?? 1) > -0.07) hi = t;
    else lo = t;
  }
  return { from, velocity: sol.velocity, spin, netClearance: sol.landing?.netClearance ?? null };
}

const PRESETS: Preset[] = [
  {
    key: 'Digit1', keyLabel: '1', label: 'Drive', rally: true,
    build: (s) => solved(V(rand(-6, 6), 2.6, 20.5 * s), V(rand(-7, 7), 0, -rand(14, 20) * s), 0.75, 55, 0.12),
  },
  {
    key: 'Digit2', keyLabel: '2', label: 'Dink', rally: true,
    build: (s) => solved(V(rand(-6, 6), 1.4, 7.8 * s), V(rand(-7, 7), 0, -rand(2.5, 6) * s), 1.05, -12, 0.15),
  },
  {
    key: 'Digit3', keyLabel: '3', label: 'Third-shot drop', rally: true,
    build: (s) => solved(V(rand(-6, 6), 2.2, 21 * s), V(rand(-7, 7), 0, -rand(3, 6.5) * s), 1.55, 15, 0.35),
  },
  {
    key: 'Digit4', keyLabel: '4', label: 'Lob', rally: true,
    build: (s) => solved(V(rand(-6, 6), 3.2, 8 * s), V(rand(-7, 7), 0, -rand(18, 21) * s), 2.3, 30, 1.5),
  },
  {
    // Server stands on their right half; serves crosscourt into the diagonal service box.
    key: 'Digit5', keyLabel: '5', label: 'Serve', rally: false,
    build: (s) => solved(V(4 * s, 1.8, 22.8 * s), V(-rand(2, 8) * s, 0, -rand(10, 20) * s), 1.25, 20, 1.0),
  },
  {
    key: 'KeyN', keyLabel: 'N', label: 'Into the net', rally: false,
    build: (s) => ({
      from: V(rand(-4, 4), 1.6, 14 * s),
      velocity: V(rand(-2, 2), 1.5, -38 * s),
      spin: V(0, 0, 0),
      netClearance: null,
    }),
  },
  { key: 'KeyX', keyLabel: 'X', label: 'Net cord', rally: false, build: netCord },
];

const RALLY = PRESETS.filter((p) => p.rally);
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

export class BallLab implements GameMode {
  private side: Side = 1;
  private auto = false;
  private autoTimer = 0;
  private lastLabel = '—';
  private lastInfo = '';
  private bounces: boolean[] = [];
  private netted = false;
  private markers: BounceMarkers;

  constructor(private w: World) {
    this.markers = new BounceMarkers(w.scene);
    // `?auto` in the URL starts with auto rally on (handy for watching / screenshots).
    this.auto = hasDebugFlag('auto');
  }

  fixedUpdate(): void {}

  cameraTargetX(): number {
    return this.w.ball.pos.x;
  }

  /** @param dt scaled game time (slow-mo aware). */
  update(dt: number): void {
    const k = this.w.keys;
    for (const p of PRESETS) if (k.wasPressed(p.key)) this.fire(p);
    if (k.wasPressed('KeyR')) this.fire(pick(RALLY));
    if (k.wasPressed('KeyF')) this.side = this.side === 1 ? -1 : 1;
    if (k.wasPressed('KeyA')) {
      this.auto = !this.auto;
      this.autoTimer = 0.2;
      this.w.hud.flash(this.auto ? 'Auto rally ON' : 'Auto rally OFF');
    }

    if (this.auto && this.shotFinished()) {
      this.autoTimer -= dt;
      if (this.autoTimer <= 0) {
        this.side = this.side === 1 ? -1 : 1;
        this.fire(pick(RALLY));
      }
    }

    this.markers.update(dt);
  }

  onBallEvent(e: BallEvent): void {
    if (e.type === 'net') {
      this.netted = true;
      this.w.hud.flash('NET!', 'bad');
    } else if (e.type === 'netcord') {
      this.w.hud.flash('Net cord!', 'info');
    } else if (e.type === 'bounce' && this.bounces.length < 2) {
      // First bounce has to be on the other side of the net to count.
      const correctSide = this.bounces.length > 0 || Math.sign(e.z) === -this.side;
      const inside = isInCourt(e.x, e.z) && correctSide;
      this.bounces.push(inside);
      this.markers.add(e.x, e.z, inside);
      if (this.bounces.length === 1) this.w.hud.flash(inside ? 'IN' : 'OUT', inside ? 'good' : 'bad', 700);
    }
  }

  describe(): string {
    const presetKeys = PRESETS.map((p) => `<b>${p.keyLabel}</b> ${p.label}`).join(' · ');
    const bounceText = this.bounces.length
      ? this.bounces.map((ok, i) => `Bounce ${i + 1}: <span class="${ok ? 'ok' : 'bad'}">${ok ? 'IN' : 'OUT'}</span>`).join(' &nbsp; ')
      : this.netted ? '<span class="bad">Hit the net</span>' : '';
    const b = this.w.ball;
    const live = `Ball height ${Math.max(0, b.pos.y - 0.12).toFixed(1)} ft · speed ${(b.vel.length() * 0.6818).toFixed(0)} mph`;
    return `
      <div class="title">Ball Lab <small>Phase 1</small></div>
      <div>${presetKeys}</div>
      <div><b>R</b> Random · <b>A</b> Auto rally ${this.auto ? '<span class="ok">ON</span>' : 'off'} · <b>F</b> Hit from ${this.side === 1 ? 'near' : 'far'} side</div>
      <hr/>
      <div class="big">${this.lastLabel}</div>
      <div>${this.lastInfo}</div>
      <div>${bounceText}</div>
      <div class="dim">${live}</div>`;
  }

  private shotFinished(): boolean {
    const b = this.w.ball;
    return !b.inPlay || this.bounces.length >= 2 || (this.netted && b.pos.y < 0.3);
  }

  private fire(p: Preset): void {
    const shot = p.build(this.side);
    this.w.ball.launch(shot.from, shot.velocity, shot.spin);
    this.w.ballView.clearTrail();
    this.bounces = [];
    this.netted = false;
    this.autoTimer = 0.6;
    this.lastLabel = p.label;

    const mph = shot.velocity.length() * 0.6818;
    const rpm = (shot.spin.length() * 60) / (2 * Math.PI);
    const isTop = shot.spin.dot(topspin(shot.velocity, 1)) >= 0;
    const spinText = rpm < 1 ? 'no spin' : `${rpm.toFixed(0)} rpm ${isTop ? 'topspin' : 'backspin'}`;
    const c = shot.netClearance;
    const netText = c === null ? '' : c >= 0 ? ` · clears net by ${(c * 12).toFixed(0)}"` : ' · aimed at the tape';
    this.lastInfo = `${mph.toFixed(0)} mph · ${spinText}${netText}`;
  }
}
