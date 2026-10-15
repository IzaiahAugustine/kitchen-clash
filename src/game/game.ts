import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ArcadeCamera } from '../camera/arcadeCamera';
import { BallLab } from '../debug/ballLab';
import { Keyboard } from '../input/keyboard';
import { Ball } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { BallView } from '../render/ballView';
import { loadCourt } from '../render/courtView';
import { Stage } from '../render/stage';
import { Hud } from '../ui/hud';

/** Top-level game: owns the loop, the world and the active mode (just the Ball Lab in phase 1). */
export class Game {
  private stage: Stage;
  private cam: ArcadeCamera;
  private keys = new Keyboard();
  private hud: Hud;
  private ball = new Ball();
  private ballView: BallView;
  private lab: BallLab;
  private clock = new THREE.Clock();
  private accumulator = 0;
  private timeScale = 1;
  private paused = false;
  private orbit: OrbitControls | null = null;

  constructor(container: HTMLElement, uiRoot: HTMLElement) {
    this.stage = new Stage(container);
    this.cam = new ArcadeCamera(window.innerWidth / window.innerHeight);
    this.hud = new Hud(uiRoot);
    this.ballView = new BallView(this.stage.scene);
    this.lab = new BallLab(this.stage.scene, this.ball, this.ballView, this.keys, this.hud);
    this.ball.hold(new THREE.Vector3(0, 3, 21));

    window.addEventListener('resize', () => {
      this.stage.resize();
      this.cam.resize(window.innerWidth / window.innerHeight);
    });
  }

  async start(): Promise<void> {
    await loadCourt(this.stage.scene);
    this.clock.start();
    this.stage.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.handleGlobalKeys();

    const gameDt = this.paused ? 0 : dt * this.timeScale;
    this.accumulator += gameDt;
    while (this.accumulator >= PHYS.fixedDt) {
      this.ball.step(PHYS.fixedDt);
      this.accumulator -= PHYS.fixedDt;
    }
    for (const e of this.ball.drainEvents()) this.lab.onBallEvent(e);

    this.lab.update(gameDt);
    this.ballView.update(this.ball, gameDt);

    if (this.orbit) this.orbit.update();
    else this.cam.update(dt, this.ball.pos.x);

    this.hud.setPanel(this.lab.describe() + this.statusLine());
    this.stage.renderer.render(this.stage.scene, this.cam.camera);
    this.keys.endFrame();
  }

  private handleGlobalKeys(): void {
    const k = this.keys;
    if (k.wasPressed('Space')) {
      this.timeScale = this.timeScale === 1 ? 0.25 : 1;
      this.hud.flash(this.timeScale === 1 ? 'Normal speed' : 'Slow-mo');
    }
    if (k.wasPressed('KeyP')) this.paused = !this.paused;
    if (k.wasPressed('KeyC')) this.toggleOrbit();
  }

  private toggleOrbit(): void {
    if (this.orbit) {
      this.orbit.dispose();
      this.orbit = null;
      this.cam.update(0, this.ball.pos.x);
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
    return `<div class="dim"><b>Space</b> Slow-mo · <b>P</b> Pause · <b>C</b> Free camera ${flags.join(' ')}</div>`;
  }
}
