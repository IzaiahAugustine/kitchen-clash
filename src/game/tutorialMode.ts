import { Vector3, type Object3D } from 'three';
import type { BallEvent } from '../physics/ball';
import { predictPath, type PathSample } from '../physics/predict';
import { topspin } from '../physics/trajectory';
import { strikeGeometry } from '../players/body';
import {
  MAX_EARLY_LEAD,
  beginSwing,
  chooseHumanContact,
  executeShot,
  findContact,
  reachAtContact,
  stretchTiming,
} from '../players/hitting';
import { HumanController } from '../players/humanController';
import { PALETTES, type Palette } from '../players/palette';
import { LUNGE_REACH, Player } from '../players/player';
import { PlayerView } from '../players/playerView';
import type { ShotKind, ShotPlan } from '../players/shots';
import { inServiceBox } from '../rules/referee';
import { clampServer, planServe, serveSetup, type ServeSetup } from '../rules/serve';
import { COURT, inKitchen, isInCourt } from './court';
import type { GameMode, World } from './mode';

type StepId = 'move' | 'drive' | 'perfect' | 'soft' | 'spin' | 'dink' | 'serve' | 'rules';

interface Step {
  id: StepId;
  title: string;
  /** Instruction text; `k` gives the right button names for keyboard or touch. */
  text: (k: Keys) => string;
  /** How many successes to finish the step (0 = just press to continue). */
  goal: number;
}

interface Keys {
  move: string;
  hit: string;
  soft: string;
  spin: string;
}

const STEPS: Step[] = [
  {
    id: 'move',
    title: 'Move',
    text: (k) => `${k.move} to move. Walk onto the glowing yellow ring.`,
    goal: 2,
  },
  {
    id: 'drive',
    title: 'Hit',
    text: (k) =>
      `The coach will feed you balls. Press <b>${k.hit}</b> as the ball comes to you to drive it back. Land 3 in the court.`,
    goal: 3,
  },
  {
    id: 'perfect',
    title: 'Timing',
    text: (k) =>
      `Timing is everything. Press <b>${k.hit}</b> a split second <i>before</i> the ball reaches you for a <b>Perfect!</b> Too early or late and the shot sprays.`,
    goal: 1,
  },
  {
    id: 'soft',
    title: 'Soft shots',
    text: (k) =>
      `<b>${k.soft}</b> hits soft. From the back of the court it's a drop shot that falls into the kitchen. Land 2.`,
    goal: 2,
  },
  {
    id: 'spin',
    title: 'Spin',
    text: (k) =>
      `<b>${k.spin}</b> hits with spin: the hardest shot in the game. From the back it's a low <b>slice</b>; at the net it's a dipping <b>topspin roll</b>. Only near-perfect timing works, and each spin shot in a row is harder than the last. Land 1 spin shot.`,
    goal: 1,
  },
  {
    id: 'dink',
    title: 'The kitchen',
    text: (k) =>
      `The light-blue zone by the net is the <b>kitchen</b>. Stand just behind its line: here <b>${k.hit}</b> plays a soft <b>dink</b>. Let the ball bounce first: volleying while standing in the kitchen is a fault! Land 2 dinks.`,
    goal: 2,
  },
  {
    id: 'serve',
    title: 'The serve',
    text: (k) =>
      `Serves are underhand and go <b>diagonally</b> into the glowing box, past the kitchen. <b>${k.hit}</b> serves hard, <b>${k.soft}</b> serves safe; ${k.move.toLowerCase()} left or right to aim. Land 1 serve.`,
    goal: 1,
  },
  {
    id: 'rules',
    title: 'Two-bounce rule',
    text: (k) =>
      `One last rule: the serve and the return must both <b>bounce</b> before anyone volleys. After that, anything goes. Scores are called server's score first, like "4-2". Press <b>${k.hit}</b> to finish!`,
    goal: 0,
  },
];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const overHead = (p: Player) => new Vector3(p.pos.x, 6.8, p.pos.z);

type Status = 'waiting' | 'feeding' | 'live' | 'between';

/**
 * Hands-on "How to Play": a coach on the far side feeds easy balls while short steps teach
 * moving, hitting, timing, soft shots, the kitchen, the serve and the two-bounce rule.
 * Each step checks you actually did it before moving on.
 */
export class TutorialMode implements GameMode {
  private you: Player;
  private coach: Player;
  private ctl: HumanController;
  private views: [Player, PlayerView][];
  private card: HTMLDivElement;
  private step = 0;
  private progress = 0;
  private status: Status = 'waiting';
  private timer = 0;
  private path: PathSample[] = [];
  private bouncesSinceHit = 0;
  private youHit = false;
  private lastKind: ShotKind | null = null;
  private lastVolleyInKitchen = false;
  private moveTarget = new Vector3();
  private serve: ServeSetup | null = null;
  private keys: Keys;
  private done = false;
  /** Game-time countdown to the next step (or to finishing), -1 when not waiting. */
  private advanceIn = -1;
  /** Called after the last step. */
  onComplete: (() => void) | null = null;

  constructor(
    private w: World,
    template: Object3D | null,
    uiRoot: HTMLElement,
    touch: boolean,
    palette?: Palette,
  ) {
    this.keys = touch
      ? { move: 'Drag the left side of the screen', hit: 'HIT', soft: 'SOFT', spin: 'SPIN' }
      : { move: 'Use WASD (or the arrow keys)', hit: 'J', soft: 'K', spin: 'L' };
    this.you = new Player('You', 1, palette ?? PALETTES.hero);
    this.coach = new Player('Coach', -1, PALETTES.rival);
    this.ctl = new HumanController(this.you);
    this.views = template
      ? [this.you, this.coach].map((p) => {
          const v = new PlayerView(template, p.palette);
          w.scene.add(v.root);
          return [p, v] as [Player, PlayerView];
        })
      : [];
    this.card = document.createElement('div');
    this.card.className = 'tutorial-card';
    uiRoot.appendChild(this.card);
    this.card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.skip !== undefined) this.nextStep();
    });
    this.startStep(0);
  }

  dispose(): void {
    for (const [, v] of this.views) this.w.scene.remove(v.root);
    this.card.remove();
    this.w.fx?.setLanding(null);
    this.w.fx?.setServeBox(null);
  }

  private get current(): Step {
    return STEPS[this.step];
  }

  private startStep(i: number): void {
    this.step = i;
    this.advanceIn = -1;
    this.progress = 0;
    this.status = 'between';
    this.timer = 0.8;
    this.serve = null;
    this.w.fx?.setLanding(null);
    this.w.fx?.setServeBox(null);
    const id = this.current.id;
    // Put everyone where this lesson needs them.
    const you = this.you;
    you.swing = null;
    you.vel.set(0, 0, 0);
    this.coach.swing = null;
    if (id === 'move') {
      you.pos.set(0, 0, 18);
      this.coach.pos.set(0, 0, -16);
      this.moveTarget.set(-4, 0, 13);
    } else if (id === 'dink') {
      you.pos.set(0, 0, COURT.kitchenDepth + 1.4);
      this.coach.pos.set(0, 0, -(COURT.kitchenDepth + 1.4));
    } else if (id === 'serve' || id === 'rules') {
      this.serve = serveSetup(1, true);
      you.pos.copy(this.serve.serverPos);
      this.coach.pos.copy(this.serve.receiverPos);
    } else {
      you.pos.set(1, 0, 19);
      this.coach.pos.set(0, 0, -15);
    }
    this.w.ball.hold(new Vector3(this.coach.pos.x + 1.4, 2.6, this.coach.pos.z + 1));
    this.renderCard();
  }

  private nextStep(): void {
    if (this.step + 1 >= STEPS.length) {
      if (!this.done) {
        this.done = true;
        this.w.hud.flash("You're ready!", 'good', 1600);
        this.w.crowd?.cheer(1);
        this.advanceIn = 0.9;
      }
      return;
    }
    this.startStep(this.step + 1);
  }

  private succeed(message = 'Nice!'): void {
    this.progress++;
    this.w.hud.tag(message, 'good', overHead(this.you));
    if (this.progress >= this.current.goal) {
      this.w.hud.flash('Step complete!', 'good', 1100);
      this.w.crowd?.cheer(0.6);
      this.w.audio?.play('cheer', { volume: 0.35 });
      this.status = 'between';
      this.timer = 1.3;
      this.advanceIn = 1.2;
    }
    this.renderCard();
  }

  private renderCard(): void {
    const s = this.current;
    const pips = s.goal
      ? `<div class="tut-pips">${Array.from({ length: s.goal }, (_, i) => `<span class="${i < this.progress ? 'on' : ''}"></span>`).join('')}</div>`
      : '';
    this.card.innerHTML = `
      <div class="tut-step">Step ${this.step + 1} of ${STEPS.length}</div>
      <div class="tut-title">${s.title}</div>
      <div class="tut-text">${s.text(this.keys)}</div>
      ${pips}
      <button class="tut-skip" data-skip>Skip step ›</button>`;
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, time: number): void {
    const { ball } = this.w;
    this.path = predictPath(ball, 1.8, this.path);
    const id = this.current.id;
    const input = this.w.controls.frame;
    if (this.w.keys.wasPressed?.('KeyN')) this.nextStep();
    if (this.advanceIn >= 0) {
      this.advanceIn -= dt;
      if (this.advanceIn < 0) {
        if (this.done) this.onComplete?.();
        else this.nextStep();
      }
    }

    if (id === 'move') {
      this.ctl.update(input, null);
      this.w.fx?.setLanding(this.moveTarget);
      if (Math.hypot(this.you.pos.x - this.moveTarget.x, this.you.pos.z - this.moveTarget.z) < 1.4 && this.progress < 2) {
        this.succeed('Got it!');
        this.moveTarget.set(4, 0, 9.5);
      }
    } else if (id === 'rules') {
      this.ctl.update({ ...input, moveX: 0, moveY: 0 }, null);
      if (input.drive || input.soft) this.nextStep();
    } else if (id === 'serve') {
      this.updateServe(time);
    } else {
      this.updateRally(dt, time);
    }

    for (const [p, v] of this.views) v.update(p, time, dt, ball.pos);
  }

  private updateServe(time: number): void {
    const s = this.serve!;
    const you = this.you;
    const button = this.ctl.update(this.w.controls.frame, null);
    if (this.status === 'live') return;
    if (!you.swing) {
      clampServer(you, s);
      const g = strikeGeometry(1.8, 'fore');
      this.w.ball.hold(new Vector3(you.pos.x + g.lateral, 1.8, you.pos.z - g.forward));
      this.w.fx?.setServeBox({ x0: 0, x1: s.boxSide * COURT.halfWidth, z0: -COURT.kitchenDepth, z1: -COURT.halfLength });
    }
    if (button && !you.swing && this.status !== 'between') {
      const hold = this.w.ball.pos.clone();
      const g = strikeGeometry(hold.y, 'fore');
      const swing = beginSwing(
        button,
        time,
        { t: 0.5, pos: hold, hand: 'fore', standAt: you.pos.clone(), crouch: g.crouch, flight: this.w.ball.flight, bounced: true },
        { kind: 'serve', feed: true, timing: { grade: 'good', error: 0 } },
      );
      swing.plan = planServe(you, s, this.ctl.aim, button, hold);
      you.swing = swing;
      this.w.fx?.setServeBox(null);
    }
    if (this.status === 'between') {
      this.timer -= 1 / 60;
      if (this.timer <= 0) this.status = 'waiting';
    }
  }

  private updateRally(dt: number, time: number): void {
    const you = this.you;
    const ball = this.w.ball;
    const incoming = this.status === 'live' && !this.youHit;
    const q = (maxTime: number) => ({ path: this.path, bouncesSoFar: this.bouncesSinceHit, maxTime, slack: 2.6 });
    const preview = incoming && !you.swing ? findContact(you, q(1.6), ball.flight) : null;
    const button = this.ctl.update(this.w.controls.frame, preview);
    if (button && you.canSwing(time)) {
      const contact = incoming ? chooseHumanContact(you, q(MAX_EARLY_LEAD + 0.3), ball.flight, this.current.id === 'dink') : null;
      const swing = beginSwing(button, time, contact);
      you.swing = swing;
      if (swing.note) this.w.hud.tag(swing.note, 'bad', overHead(you));
      if (button === 'drive' && this.current.id === 'soft') this.w.hud.tag(`Use ${this.keys.soft} for soft shots`, 'info', overHead(you), 1400);
      if (button !== 'spin' && this.current.id === 'spin') this.w.hud.tag(`Use ${this.keys.spin} for spin`, 'info', overHead(you), 1400);
    }
    // Show where the coach's feed will land, like in a real match.
    const s = incoming && this.bouncesSinceHit === 0 ? this.path.find((p) => p.bounces >= 1) : undefined;
    this.w.fx?.setLanding(s && s.z > 0 ? new Vector3(s.x, 0, s.z) : null);

    if (this.status === 'between' || this.status === 'waiting') {
      this.timer -= dt;
      if (this.timer <= 0 && this.progress < this.current.goal) this.feed(time);
    }
  }

  /** The coach drops a ball and plays a gentle shot to you, designed to be easy to hit. */
  private feed(time: number): void {
    const coach = this.coach;
    const you = this.you;
    const g = strikeGeometry(2.4, 'fore');
    const hold = new Vector3(coach.pos.x + coach.right.x * g.lateral, 2.4, coach.pos.z + coach.forward.z * g.forward);
    this.w.ball.hold(hold);
    const dink = this.current.id === 'dink';
    const target = new Vector3(
      Math.max(-8, Math.min(8, you.pos.x + rand(-1.5, 1.5))),
      0,
      dink ? rand(4, 5.5) : Math.max(COURT.kitchenDepth + 2, you.pos.z - rand(4, 6)),
    );
    const plan: ShotPlan = {
      target,
      flightTime: dink ? 1.05 : 1.2,
      spin: topspin(target.clone().sub(hold), dink ? -8 : 20),
      clearance: dink ? 0.4 : 1.0,
    };
    const swing = beginSwing(
      'drive',
      time,
      { t: 0.5, pos: hold, hand: 'fore', standAt: coach.pos.clone(), crouch: g.crouch, flight: this.w.ball.flight, bounced: true },
      { kind: dink ? 'dink' : 'drive', feed: true, timing: { grade: 'good', error: 0 } },
    );
    swing.plan = plan;
    coach.swing = swing;
    this.status = 'feeding';
  }

  fixedUpdate(dt: number, time: number): void {
    const { ball } = this.w;
    for (const p of [this.you, this.coach]) {
      p.step(dt, time);
      const sw = p.swing;
      if (!sw || sw.resolved || !sw.contact || time + 1e-9 < sw.contactAt) continue;
      sw.resolved = true;
      if (sw.feed) {
        executeShot(ball, p, sw, { x: 0, y: 0 });
        this.bouncesSinceHit = 0;
        this.youHit = p === this.you;
        this.status = 'live';
        if (p === this.you) this.lastKind = 'serve';
        continue;
      }
      if (p !== this.you || this.status !== 'live' || this.youHit || ball.flight !== sw.contact.flight) continue;
      const reach = reachAtContact(p);
      if (reach === 'miss') {
        this.w.hud.tag('Too far!', 'bad', overHead(p));
        continue;
      }
      if (reach === 'stretch' && sw.timing) sw.timing = stretchTiming(sw.timing);
      this.lastVolleyInKitchen = this.bouncesSinceHit === 0 && inKitchen(p.pos.z);
      const report = executeShot(ball, p, sw, this.ctl.aim);
      this.youHit = true;
      this.bouncesSinceHit = 0;
      this.lastKind = report.kind;
      const grade = report.timing.grade;
      if (p.contactGap() <= LUNGE_REACH) {
        const text = grade === 'perfect' ? 'Perfect!' : grade === 'good' ? 'Nice!' : grade === 'early' ? 'Early' : 'Late';
        this.w.hud.tag(text, grade === 'perfect' ? 'good' : grade === 'good' ? 'info' : 'bad', overHead(p));
      }
      if (this.current.id === 'perfect' && grade === 'perfect') {
        this.w.fx?.burst(ball.pos, 1, true);
        this.succeed('Perfect!');
      }
      if (this.lastVolleyInKitchen && this.current.id === 'dink') {
        this.w.hud.flash('KITCHEN FAULT!', 'bad', 1800, "You volleyed while standing in the kitchen. Step back, or let it bounce.");
        this.endBall(1.8);
      }
    }
  }

  onBallEvent(e: BallEvent): void {
    if (this.status !== 'live') return;
    const id = this.current.id;
    if (e.type === 'net') {
      this.w.hud.tag('Into the net', 'bad', new Vector3(e.x, 4, 0));
      this.endBall();
      return;
    }
    if (e.type !== 'bounce') return;
    this.bouncesSinceHit++;
    if (!this.youHit) {
      // The coach's feed: missing it is fine, the next one's coming.
      if (this.bouncesSinceHit >= 2) {
        this.w.hud.tag('Missed it, here comes another', 'info', overHead(this.you), 1300);
        this.endBall();
      }
      return;
    }
    if (this.bouncesSinceHit > 1) return;
    if (id === 'serve') {
      if (this.serve && inServiceBox(e.x, e.z, -1, this.serve.boxSide)) this.succeed('In!');
      else {
        const short = Math.abs(e.z) <= COURT.kitchenDepth;
        this.w.hud.flash(short ? 'Short!' : 'Out!', 'bad', 1500, short ? 'Serves have to clear the kitchen.' : 'Aim for the glowing box, diagonally across.');
        this.endBall();
      }
      return;
    }
    const inside = e.z < 0 && isInCourt(e.x, e.z);
    if (!inside) {
      this.w.hud.tag('Out', 'bad', new Vector3(e.x, 2, e.z));
      this.endBall();
      return;
    }
    const k = this.lastKind;
    if (id === 'drive') this.succeed('In!');
    else if (id === 'soft' && (k === 'drop' || k === 'reset' || k === 'lob')) this.succeed('Great drop!');
    else if (id === 'spin' && (k === 'slice' || k === 'roll')) this.succeed('Nice spin!');
    else if (id === 'dink' && k === 'dink' && !this.lastVolleyInKitchen) this.succeed('Nice dink!');
    this.endBall();
  }

  private endBall(delay = 1.2): void {
    if (this.status !== 'live') return;
    this.status = 'between';
    this.timer = delay;
    this.youHit = false;
  }

  describe(): string {
    return `<div class="title">Kitchen Clash <small>How to play</small></div>
      <div class="dim"><b>N</b> Skip step · <b>P</b> Menu</div>`;
  }

  cornerText(): string {
    return '<span class="dim"><b>N</b> Skip step · <b>P</b> Menu</span>';
  }

  cameraTargetX(): number {
    return this.you.pos.x;
  }
}
