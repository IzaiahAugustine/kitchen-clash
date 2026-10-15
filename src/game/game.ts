import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PROFILES, parseDifficulty, type Difficulty } from '../ai/difficulty';
import { Sound } from '../audio/sound';
import { ArcadeCamera } from '../camera/arcadeCamera';
import { BallLab } from '../debug/ballLab';
import { Controls } from '../input/controls';
import { Keyboard } from '../input/keyboard';
import { Ball, type BallEvent } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { loadPlayerTemplate } from '../players/playerView';
import { BallView } from '../render/ballView';
import { loadCourt } from '../render/courtView';
import { Crowd } from '../render/crowd';
import { Stage } from '../render/stage';
import { DEFAULT_SCORING } from '../rules/scoring';
import { Hud } from '../ui/hud';
import { Menu, type MenuScreen } from '../ui/menu';
import { Scoreboard } from '../ui/scoreboard';
import { debugFlag, hasDebugFlag } from './debugFlags';
import { MatchMode, type Controller, type MatchResult } from './matchMode';
import type { GameMode, World } from './mode';
import { PracticeMode } from './practiceMode';
import { loadSettings, saveSettings, type CameraPreset, type Settings } from './settings';

type AppState = 'title' | 'playing' | 'paused' | 'results';

const LEVELS: Difficulty[] = ['easy', 'medium', 'hard'];
const CAMERAS: CameraPreset[] = ['close', 'classic', 'wide'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Top-level game: owns the renderer, the loop, the shared world and the menus, and runs the
 * active mode. The title screen plays an AI vs AI match behind the menu.
 * Debug URL flags skip the title: ?lab, ?practice, ?watch, ?difficulty=…
 */
export class Game {
  private stage: Stage;
  private cam: ArcadeCamera;
  private world: World;
  private mode: GameMode | null = null;
  private template: THREE.Object3D | null = null;
  private state: AppState = 'title';
  private settings = loadSettings();
  private sound = new Sound();
  private menu: Menu;
  private scoreboard: Scoreboard;
  private crowd: Crowd;
  private titleArt: string | null = null;
  private lastFrameAt = 0;
  private accumulator = 0;
  private time = 0;
  private timeScale = 1;
  private orbit: OrbitControls | null = null;
  private lastFlight = 0;
  /** What "Rematch" / "Restart" restarts. */
  private current: { near: Controller; far: Difficulty } | 'practice' = { near: 'human', far: 'medium' };

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
      audio: this.sound,
      crowd: this.crowd,
    };
    this.scoreboard = new Scoreboard(this.uiRoot, ['YOU', 'CPU'], ['#ff6b35', '#7b2ff7']);
    this.world.hud.projector = (p) => {
      const v = p.clone().project(this.cam.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
      return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
    };
    this.menu = new Menu(this.uiRoot);
    this.menu.onNavigate = () => this.sound.play('click', { volume: 0.5 });
    this.applySettings();

    window.addEventListener('resize', () => {
      this.stage.resize();
      this.cam.resize(window.innerWidth / window.innerHeight);
    });
  }

  async start(): Promise<void> {
    const lab = hasDebugFlag('lab');
    const [, template] = await Promise.all([loadCourt(this.stage.scene), lab ? null : loadPlayerTemplate()]);
    this.template = template;
    void this.findTitleArt();

    if (lab) {
      this.setMode(new BallLab(this.world));
      this.enterPlaying();
    } else if (hasDebugFlag('practice')) {
      this.startPractice();
    } else if (hasDebugFlag('watch') || hasDebugFlag('autoplay')) {
      const far = parseDifficulty(debugFlag('difficulty'));
      this.startMatch(parseDifficulty(debugFlag('near'), far), far);
    } else if (debugFlag('difficulty')) {
      this.startMatch('human', parseDifficulty(debugFlag('difficulty')));
    } else {
      this.showTitle();
    }

    // Debug: `?warp=6` fast-forwards 6 seconds of play before the first frame (for screenshots).
    const warp = Number(debugFlag('warp') ?? 0);
    for (let i = 0; i < warp * 60; i++) this.advance(1 / 60);
    this.lastFrameAt = performance.now();
    this.stage.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- modes & screens

  private setMode(mode: GameMode): void {
    this.mode?.dispose?.();
    this.mode = mode;
    this.world.ballView.clearTrail();
  }

  private matchMode(near: Controller, far: Difficulty): MatchMode {
    const label = (c: Controller) => (c === 'human' ? 'YOU' : `CPU ${PROFILES[c].label.toUpperCase()}`);
    this.scoreboard.setNames([label(near), label(far)]);
    const m = new MatchMode(this.world, this.template, this.scoreboard, {
      scoring: { ...DEFAULT_SCORING, mode: debugFlag('scoring') === 'rally' ? 'rally' : this.settings.scoring },
      near,
      far,
    });
    m.onGameOver = (r) => this.showResults(r);
    return m;
  }

  private startMatch(near: Controller, far: Difficulty): void {
    this.current = { near, far };
    this.setMode(this.matchMode(near, far));
    this.enterPlaying();
  }

  private startPractice(): void {
    this.current = 'practice';
    this.setMode(new PracticeMode(this.world, this.template));
    this.enterPlaying();
  }

  private restart(): void {
    if (this.current === 'practice') this.startPractice();
    else this.startMatch(this.current.near, this.current.far);
  }

  private enterPlaying(): void {
    this.state = 'playing';
    this.menu.hide();
    this.world.hud.muted = false;
    this.scoreboard.setVisible(this.mode instanceof MatchMode);
    this.sound.setMusic(false);
    this.sound.setAmbience(true);
  }

  /** Title screen, with a CPU match playing behind it. */
  private showTitle(): void {
    this.state = 'title';
    this.setMode(this.matchMode('medium', 'hard'));
    this.world.hud.muted = true;
    this.scoreboard.setVisible(false);
    this.sound.setMusic(true);
    this.sound.setAmbience(true);
    const s = this.settings;
    this.menu.show({
      variant: 'title',
      header: `<div class="logo">KITCHEN<span class="clash">CLASH!</span></div><div class="tagline">Arcade Pickleball</div>`,
      items: [
        { label: '▶ Play vs AI', primary: true, action: () => this.startMatch('human', s.difficulty) },
        this.option('Difficulty', LEVELS.map(cap), () => LEVELS.indexOf(s.difficulty), (i) => (s.difficulty = LEVELS[i])),
        { label: 'Watch AI vs AI', action: () => this.showWatchSetup() },
        { label: 'Practice', action: () => this.startPractice() },
        { label: 'Settings', action: () => this.showSettings(() => this.showTitle()) },
      ],
    });
  }

  private showWatchSetup(): void {
    const s = this.settings;
    this.menu.show({
      variant: 'title',
      header: '<div class="menu-headline">Watch AI vs AI</div><div class="menu-sub">F fast-forwards · Esc for the menu</div>',
      items: [
        this.option('Orange player', LEVELS.map(cap), () => LEVELS.indexOf(s.watchNear), (i) => (s.watchNear = LEVELS[i])),
        this.option('Purple player', LEVELS.map(cap), () => LEVELS.indexOf(s.watchFar), (i) => (s.watchFar = LEVELS[i])),
        { label: '▶ Start', primary: true, action: () => this.startMatch(s.watchNear, s.watchFar) },
        { label: 'Back', action: () => this.showTitle() },
      ],
      back: () => this.showTitle(),
    });
  }

  private showSettings(back: () => void): void {
    const s = this.settings;
    const vols = Array.from({ length: 11 }, (_, i) => String(i));
    this.menu.show({
      variant: this.state === 'title' ? 'title' : '',
      header: '<div class="menu-headline">Settings</div>',
      items: [
        this.option('Scoring', ['Side-out', 'Rally'], () => (s.scoring === 'rally' ? 1 : 0), (i) => (s.scoring = i ? 'rally' : 'sideout')),
        this.option('Camera', CAMERAS.map(cap), () => CAMERAS.indexOf(s.camera), (i) => (s.camera = CAMERAS[i])),
        this.option('Sound effects', vols, () => s.sfxVolume, (i) => (s.sfxVolume = i)),
        this.option('Music', vols, () => s.musicVolume, (i) => (s.musicVolume = i)),
        this.option('Graphics', ['Standard', 'High'], () => (s.graphics === 'high' ? 1 : 0), (i) => (s.graphics = i ? 'high' : 'standard')),
        { label: 'Back', primary: true, action: back },
      ],
      back,
    });
  }

  private showPause(): void {
    this.state = 'paused';
    this.sound.setMusic(true);
    this.menu.show({
      header: '<div class="menu-headline">Paused</div>',
      items: [
        { label: '▶ Resume', primary: true, action: () => this.enterPlaying() },
        { label: 'Restart', action: () => this.restart() },
        { label: 'Settings', action: () => this.showSettings(() => this.showPause()) },
        { label: 'Quit to menu', action: () => this.showTitle() },
      ],
      back: () => this.enterPlaying(),
    });
  }

  private showResults(r: MatchResult): void {
    if (this.state !== 'playing') return;
    this.state = 'results';
    this.sound.setMusic(true);
    const youWon = r.names[r.winner] === 'YOU';
    const headline = youWon ? 'YOU WIN!' : r.names[0] === 'YOU' ? 'SO CLOSE!' : `${r.names[r.winner]} WINS`;
    const stats = [
      ['Rallies won', `${r.ralliesWon[0]}–${r.ralliesWon[1]}`],
      ['Longest rally', `${r.longestRally} shots`],
      ...(r.names[0] === 'YOU' ? [['Perfect hits', String(r.perfects)]] : []),
    ]
      .map(([k, v]) => `<div><b>${v}</b>${k}</div>`)
      .join('');
    const screen: MenuScreen = {
      header: `<div class="menu-headline">${headline}</div>
        <div class="result-score">${r.points[0]} – ${r.points[1]}</div>
        <div class="menu-sub">${r.names[0]} vs ${r.names[1]}</div>
        <div class="result-stats">${stats}</div>`,
      items: [
        { label: '▶ Rematch', primary: true, action: () => this.restart() },
        { label: 'Main menu', action: () => this.showTitle() },
      ],
    };
    this.menu.show(screen);
  }

  private option(label: string, options: string[], get: () => number, set: (i: number) => void) {
    return {
      label,
      options,
      get,
      set: (i: number) => {
        set(i);
        this.applySettings();
      },
    };
  }

  private applySettings(): void {
    const s: Settings = this.settings;
    saveSettings(s);
    this.cam.setPreset(s.camera);
    this.sound.setVolumes(s.sfxVolume, s.musicVolume);
    this.stage.setHighQuality(s.graphics === 'high' || hasDebugFlag('hifx'));
  }

  /** Title art generated with Artlist, if it's been added to public/art/. */
  private async findTitleArt(): Promise<void> {
    for (const ext of ['jpg', 'png', 'webp']) {
      const url = `${import.meta.env.BASE_URL}art/title.${ext}`;
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) {
          // Preload so the title screen doesn't flash empty, then use it as the backdrop.
          await new Promise((done) => {
            const img = new Image();
            img.onload = img.onerror = done;
            img.src = url;
          });
          this.titleArt = url;
          document.documentElement.style.setProperty('--title-art', `url("${url}")`);
          return;
        }
      } catch {
        // no art yet
      }
    }
  }

  // ---------------------------------------------------------------- loop

  private frame(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.1);
    this.lastFrameAt = now;
    this.advance(dt);
    // The title art covers the 3D scene, so don't spend the GPU drawing it.
    const covered = this.state === 'title' && this.titleArt !== null && this.menu.open;
    if (!covered) this.stage.render(this.cam.camera);
    this.stage.adaptQuality(dt, now);
    this.world.keys.endFrame();
  }

  /** Runs one frame of game logic (everything except drawing). */
  private advance(dt: number): void {
    const mode = this.mode!;
    const { ball, ballView, hud, controls, keys } = this.world;
    const input = controls.update();

    if (this.menu.open) {
      this.menu.handleKeys(keys);
      // Keys used in a menu (Enter, J…) shouldn't also swing or serve in the game.
      controls.frame = { ...input, drive: false, soft: false, feed: false, pause: false };
    } else {
      this.handleGlobalKeys(input.pause);
    }

    const frozen = this.state === 'paused' || this.state === 'results';
    const gameDt = frozen ? 0 : dt * this.timeScale;
    this.accumulator += gameDt;
    while (this.accumulator >= PHYS.fixedDt) {
      mode.fixedUpdate(PHYS.fixedDt, this.time);
      ball.step(PHYS.fixedDt);
      this.time += PHYS.fixedDt;
      for (const e of ball.drainEvents()) {
        mode.onBallEvent(e, this.time);
        this.ballSound(e);
      }
      this.accumulator -= PHYS.fixedDt;
    }
    if (ball.flight !== this.lastFlight) {
      this.lastFlight = ball.flight;
      this.hitSound();
    }

    if (!frozen) mode.update(gameDt, this.time);
    ballView.update(ball, gameDt);
    this.crowd.update(this.time, gameDt);

    if (this.orbit) this.orbit.update();
    else if (this.state === 'title') this.cam.orbit(dt);
    else this.cam.update(dt, mode.cameraTargetX());

    hud.setPanel(mode.describe() + this.statusLine());
  }

  /** Paddle "pop": louder for harder hits, panned to where it was struck. */
  private hitSound(): void {
    const b = this.world.ball;
    const power = Math.min(1, b.vel.length() / 60);
    this.sound.play('paddle', {
      volume: this.spatial(b.pos) * (0.45 + 0.55 * power),
      pitch: 0.92 + Math.random() * 0.16 + power * 0.08,
      pan: b.pos.x / 14,
    });
  }

  private ballSound(e: BallEvent): void {
    const pos = new THREE.Vector3(e.x, e.y, e.z);
    if (e.type === 'bounce') {
      this.sound.play('bounce', { volume: this.spatial(pos) * Math.min(1, 0.2 + e.speed / 30), pitch: 0.95 + Math.random() * 0.1, pan: e.x / 14 });
    } else {
      this.sound.play('net', { volume: e.type === 'net' ? 0.9 : 0.5, pan: e.x / 14 });
    }
  }

  /** Farther from the camera is quieter; the title screen is quieter overall. */
  private spatial(p: THREE.Vector3): number {
    const d = this.cam.camera.position.distanceTo(p);
    return Math.max(0.25, Math.min(1, 34 / d)) * (this.state === 'title' ? 0.45 : 1);
  }

  private handleGlobalKeys(pausePressed: boolean): void {
    const k = this.world.keys;
    if (pausePressed && this.state === 'playing') {
      this.showPause();
      return;
    }
    if (k.wasPressed('KeyT')) {
      this.timeScale = this.timeScale === 1 ? 0.25 : 1;
      this.world.hud.flash(this.timeScale === 1 ? 'Normal speed' : 'Slow-mo');
    }
    if (k.wasPressed('KeyF')) {
      this.timeScale = this.timeScale === 3 ? 1 : 3;
      this.world.hud.flash(this.timeScale === 3 ? 'Fast-forward' : 'Normal speed');
    }
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
      this.timeScale < 1 ? '<span class="ok">SLOW-MO</span>' : '',
      this.timeScale > 1 ? '<span class="ok">FAST ×3</span>' : '',
      this.orbit ? '<span class="ok">FREE CAM</span> (drag to orbit, scroll to zoom)' : '',
    ].filter(Boolean);
    return `<div class="dim"><b>Esc</b> / <b>P</b> Pause ${flags.join(' ')}</div>`;
  }
}
