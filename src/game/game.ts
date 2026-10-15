import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ArcadeCamera } from '../camera/arcadeCamera';
import { BallLab } from '../debug/ballLab';
import { Controls } from '../input/controls';
import { Keyboard } from '../input/keyboard';
import { Ball } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { loadPlayerTemplate } from '../players/playerView';
import { BallView } from '../render/ballView';
import { Crowd } from '../render/crowd';
import { loadCourt } from '../render/courtView';
import { Stage } from '../render/stage';
import { Hud } from '../ui/hud';
import { debugFlag, hasDebugFlag } from './debugFlags';
import type { GameMode, World } from './mode';
import { DEFAULT_SCORING } from '../rules/scoring';
import { Scoreboard } from '../ui/scoreboard';
import { MatchMode } from './matchMode';
import { PracticeMode } from './practiceMode';

/**
 * Top-level game: owns the renderer, the loop and the shared world, and runs the active
 * mode. `?lab` in the URL opens the Ball Lab instead of practice.
 */
export class Game {
  private stage: Stage;
  private cam: ArcadeCamera;
  private world: World;
  private mode: GameMode | null = null;
  private lastFrameAt = 0;
  private accumulator = 0;
  private time = 0;
  private timeScale = 1;
  private paused = false;
  private orbit: OrbitControls | null = null;
  private crowd: Crowd;

  constructor(
    container: HTMLElement,
    private uiRoot: HTMLElement,
  ) {
    this.stage = new Stage(container);
    this.cam = new ArcadeCamera(window.innerWidth / window.innerHeight);
    this.stage.setupPost(this.cam.camera);
    this.crowd = new Crowd(this.stage.scene);
    const keys = new Keyboard();
    const ball = new Ball();
    ball.hold(new THREE.Vector3(0, 3, 21));
    this.world = {
      scene: this.stage.scene,
      ball,
      ballView: new BallView(this.stage.scene),
      hud: new Hud(this.uiRoot),
      keys,
      controls: new Controls(keys),
    };

    window.addEventListener('resize', () => {
      this.stage.resize();
      this.cam.resize(window.innerWidth / window.innerHeight);
    });
  }

  async start(): Promise<void> {
    const lab = hasDebugFlag('lab');
    const [, template] = await Promise.all([loadCourt(this.stage.scene), lab ? null : loadPlayerTemplate()]);
    if (!template) this.mode = new BallLab(this.world);
    else if (hasDebugFlag('practice')) this.mode = new PracticeMode(this.world, template);
    else {
      const scoreboard = new Scoreboard(this.uiRoot, ['YOU', 'BOT'], ['#ff6b35', '#7b2ff7']);
      const scoring = debugFlag('scoring') === 'rally' ? 'rally' : 'sideout';
      this.mode = new MatchMode(this.world, template, scoreboard, { ...DEFAULT_SCORING, mode: scoring });
    }
    // Debug: `?warp=6` fast-forwards 6 seconds of play before the first frame (for screenshots).
    const warp = Number(debugFlag('warp') ?? 0);
    for (let i = 0; i < warp * 60; i++) this.advance(1 / 60);
    this.lastFrameAt = performance.now();
    this.stage.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.1);
    this.lastFrameAt = now;
    this.advance(dt);
    this.stage.render(this.cam.camera);
    this.stage.adaptQuality(dt, now);
    this.world.keys.endFrame();
  }

  /** Runs one frame of game logic (everything except drawing). */
  private advance(dt: number): void {
    const mode = this.mode!;
    const { ball, ballView, hud, controls } = this.world;
    const input = controls.update();
    this.handleGlobalKeys(input.pause);

    const gameDt = this.paused ? 0 : dt * this.timeScale;
    this.accumulator += gameDt;
    while (this.accumulator >= PHYS.fixedDt) {
      mode.fixedUpdate(PHYS.fixedDt, this.time);
      ball.step(PHYS.fixedDt);
      this.time += PHYS.fixedDt;
      for (const e of ball.drainEvents()) mode.onBallEvent(e, this.time);
      this.accumulator -= PHYS.fixedDt;
    }

    if (!this.paused) mode.update(gameDt, this.time);
    ballView.update(ball, gameDt);
    this.crowd.update(this.time, gameDt);

    if (this.orbit) this.orbit.update();
    else this.cam.update(dt, mode.cameraTargetX());

    hud.setPanel(mode.describe() + this.statusLine());
  }

  private handleGlobalKeys(pausePressed: boolean): void {
    const k = this.world.keys;
    if (k.wasPressed('KeyT')) {
      this.timeScale = this.timeScale === 1 ? 0.25 : 1;
      this.world.hud.flash(this.timeScale === 1 ? 'Normal speed' : 'Slow-mo');
    }
    if (pausePressed) this.paused = !this.paused;
    if (k.wasPressed('KeyC')) this.toggleOrbit();
  }

  private toggleOrbit(): void {
    if (this.orbit) {
      this.orbit.dispose();
      this.orbit = null;
    } else {
      this.orbit = new OrbitControls(this.cam.camera, this.stage.renderer.domElement);
      this.orbit.target.set(0, 0, 0);
      this.orbit.enableDamping = true;
    }
  }

  private statusLine(): string {
    const flags = [
      this.paused ? '<span class="bad">PAUSED</span>' : '',
      this.timeScale !== 1 ? '<span class="ok">SLOW-MO</span>' : '',
      this.orbit ? '<span class="ok">FREE CAM</span> (drag to orbit, scroll to zoom)' : '',
    ].filter(Boolean);
    return `<div class="dim"><b>P</b> Pause · <b>T</b> Slow-mo · <b>C</b> Free camera ${flags.join(' ')}</div>`;
  }
}
