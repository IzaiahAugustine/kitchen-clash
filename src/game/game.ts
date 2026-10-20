import * as THREE from 'three';
import { netStats } from '../net/stats';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseDifficulty, type Difficulty } from '../ai/difficulty';
import { Sound } from '../audio/sound';
import { ArcadeCamera } from '../camera/arcadeCamera';
import { BallLab } from '../debug/ballLab';
import { Controls } from '../input/controls';
import { Keyboard } from '../input/keyboard';
import { Ball, type BallEvent } from '../physics/ball';
import { PHYS } from '../physics/constants';
import { loadPlayerTemplate } from '../players/playerView';
import { BallView } from '../render/ballView';
import { hideFenceBehind, loadCourt } from '../render/courtView';
import { Crowd } from '../render/crowd';
import { Effects } from '../render/effects';
import { Stage } from '../render/stage';
import { DEFAULT_SCORING } from '../rules/scoring';
import { Hud } from '../ui/hud';
import { Menu, type MenuScreen } from '../ui/menu';
import { Scoreboard } from '../ui/scoreboard';
import { Coach } from '../ui/coach';
import { debugFlag, hasDebugFlag } from './debugFlags';
import { MatchMode, type Controller, type MatchResult } from './matchMode';
import type { GameMode, World } from './mode';
import { PracticeMode } from './practiceMode';
import { Replay } from './replay';
import type { Room } from '../net/room';
import { OnlineHost } from '../net/onlineHost';
import { OnlineGuest } from '../net/onlineGuest';
import { TutorialMode } from './tutorialMode';
import { ShowroomMode } from './showroomMode';
import { RIVALS, rewardsFor } from './tournament';
import { VENUES, VENUE_ORDER, VenueDresser, type VenueId } from '../render/venues';
import {
  CAP_COLORS,
  HAIR_COLORS,
  type LookOption,
  HAIR_STYLES,
  HEADWEAR,
  PADDLES,
  SHIRTS,
  SHORTS,
  SKIN_TONES,
  available,
  lookToPalette,
  type Look,
} from '../players/look';
import { TouchControls, isTouchDevice } from '../input/touch';
import { loadSettings, saveSettings, type CameraPreset, type Settings } from './settings';
import { portal } from '../platform/portal';
import { ACHIEVEMENTS, Progress, type MatchContext, type MatchTracker } from './progress';

type AppState = 'title' | 'playing' | 'paused' | 'results' | 'replay';

const LEVELS: Difficulty[] = ['easy', 'medium', 'hard'];
type LookOptionList = LookOption[];
/** A little gold coin (drawn in CSS, so it looks the same everywhere). */
const coinIcon = () => '<span class="coin"></span>';
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
  /** A portal ad is playing: the game is silent. */
  private adPlaying = false;
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
  private effects: Effects;
  /** Seconds of freeze-frame left (big hits). */
  private freeze = 0;
  /** What "Rematch" / "Restart" restarts. */
  private touch: TouchControls | null = null;
  private venues: VenueDresser | null = null;
  private venueId: VenueId | null = null;
  private coach: Coach;
  private crowdTick = false;
  /** Instant replays of great points (offline matches you play). */
  private replay = new Replay();
  /** A replay is due: of game time from..to, starting once the clock reaches `to`. */
  private replayDue: { from: number; to: number } | null = null;
  private lastReplayAt = -Infinity;
  private replayStartedAt = 0;
  private replayUi: HTMLDivElement;
  private flashEl: HTMLDivElement;
  private replaySide = 1;
  private replayLook = new THREE.Vector3();
  private progress: Progress;
  /** Counting coins/challenges for the match being played (null when it doesn't count). */
  private tracker: MatchTracker | null = null;
  /** Rewards earned during the current match (listed on the results screen). */
  private matchRewards: string[] = [];
  private court: THREE.Object3D | null = null;
  /** Seconds since this match (or resume) began, for the control hints. */
  private matchClock = 0;
  private fpsFrom = 0;
  private fpsFrames = 0;
  /** The online room while in an online match (or waiting for a friend). */
  private room: Room | null = null;
  private current:
    | { near: Controller; far: Difficulty; doubles: boolean }
    | { tournament: number }
    | 'practice'
    | 'tutorial'
    | 'online' = {
    near: 'human',
    far: 'medium',
    doubles: false,
  };

  constructor(
    container: HTMLElement,
    private uiRoot: HTMLElement,
  ) {
    this.stage = new Stage(container);
    this.cam = new ArcadeCamera(window.innerWidth / window.innerHeight);
    this.stage.setupPost(this.cam.camera);
    this.crowd = new Crowd(this.stage.scene);
    this.effects = new Effects(this.stage.scene);
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
      fx: {
        burst: (at, power, perfect) => this.effects.burst(at, power, perfect),
        setLanding: (p) => this.effects.setLanding(p),
        setServeBox: (b) => this.effects.setServeBox(b),
        shake: (a) => this.cam.shake(a),
        // Never online: freezing one player's clock pulls the two games out of step.
        hitstop: (s) => {
          if (!this.mode?.online) this.freeze = Math.max(this.freeze, s);
        },
        punch: (a) => {
          this.cam.punch(a);
          this.screenFlash(a);
        },
        confetti: (at) => this.effects.confetti(at),
      },
    };
    this.scoreboard = new Scoreboard(this.uiRoot, ['YOU', 'CPU'], ['#ff6b35', '#7b2ff7']);
    this.world.hud.projector = (p) => {
      const v = p.clone().project(this.cam.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
      return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
    };
    this.coach = new Coach(this.uiRoot);
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'screen-flash';
    this.uiRoot.append(this.flashEl);
    this.replayUi = document.createElement('div');
    this.replayUi.className = 'replay hidden';
    this.replayUi.innerHTML = `<div class="replay-bar top"></div><div class="replay-bar bottom"></div><div class="replay-tag"><span class="rec"></span>REPLAY</div><div class="replay-skip">${isTouchDevice() ? 'Tap' : 'Press any key'} to skip</div>`;
    this.uiRoot.append(this.replayUi);
    const skip = (e: Event) => {
      if (this.state !== 'replay' || (e as KeyboardEvent).repeat) return;
      // Ignore a key still held from the point itself.
      if (performance.now() - this.replayStartedAt > 350) this.endReplay();
    };
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    this.menu = new Menu(this.uiRoot);
    this.menu.onNavigate = () => this.sound.play('click', { volume: 0.5 });
    // Phones and tablets get on-screen controls (`?touch` forces them for testing).
    if (isTouchDevice() || hasDebugFlag('touch')) {
      this.touch = new TouchControls(this.uiRoot);
      this.world.controls.touch = this.touch;
      this.menu.touch = true;
      document.body.classList.add('touch');
    }
    this.progress = new Progress(this.settings.progress, () => saveSettings(this.settings));
    this.progress.onReward = (r) => {
      this.matchRewards.push(`${r.title.replace('!', '')}: ${r.detail} (+${r.coins})`);
      const hud = this.world.hud;
      const was = hud.muted;
      hud.muted = false;
      hud.flash(r.title, 'good', 2400, `${r.detail} · +${r.coins} coins`);
      hud.muted = was;
      this.sound.play('click', { volume: 0.8, pitch: 1.5 });
    };
    this.applySettings();
    // Test hook for poking at the game from the browser console.
    if (hasDebugFlag('debug')) (window as unknown as { __game: Game }).__game = this;
    portal.onMuteChange = () => this.sound.setMuted(portal.muted || this.adPlaying);
    portal.onAdStart = () => {
      this.adPlaying = true;
      this.sound.setMuted(true);
    };
    portal.onAdEnd = () => {
      this.adPlaying = false;
      this.sound.setMuted(portal.muted);
    };

    window.addEventListener('resize', () => {
      this.stage.resize();
      this.cam.resize(window.innerWidth / window.innerHeight);
    });
  }

  async start(): Promise<void> {
    const lab = hasDebugFlag('lab');
    const [court, template] = await Promise.all([
      loadCourt(this.stage.scene, this.stage.renderer.capabilities.getMaxAnisotropy()),
      lab ? null : loadPlayerTemplate(),
    ]);
    this.template = template;
    this.court = court;
    this.venues = new VenueDresser(this.stage.scene, court, this.stage.hemi, this.stage.sun, this.stage.renderer);
    // Debug: `?court=beach` picks the court for this session.
    const court0 = debugFlag('court');
    if (court0 && court0 in VENUES) this.settings.court = court0 as VenueId;
    this.setVenue(this.settings.court);
    // The title screen shows the real game (an AI match) behind the menu, so what players see
    // first is what they get. Painted title art (public/art/) is only used with ?titleart.
    if (hasDebugFlag('titleart')) void this.findTitleArt();

    if (lab) {
      this.setMode(new BallLab(this.world));
      this.enterPlaying();
    } else if (hasDebugFlag('practice')) {
      this.startPractice();
    } else if (hasDebugFlag('tutorial')) {
      this.startTutorial();
    } else if (hasDebugFlag('watch') || hasDebugFlag('autoplay')) {
      const far = parseDifficulty(debugFlag('difficulty'));
      this.startMatch(parseDifficulty(debugFlag('near'), far), far, hasDebugFlag('doubles'));
    } else if (debugFlag('online') === 'host') {
      // Test hook: create a match straight away.
      this.showTitle();
      void this.createOnline();
    } else if (debugFlag('join')) {
      this.showTitle();
      this.showJoin(debugFlag('join') ?? '');
      // Test hook: join without pressing the button.
      if (hasDebugFlag('autojoin')) void this.joinOnline(debugFlag('join') ?? '');
    } else if (hasDebugFlag('myplayer')) {
      this.showMyPlayer(() => this.showTitle());
    } else if (hasDebugFlag('tournament')) {
      this.showTournament();
    } else if (debugFlag('difficulty') || hasDebugFlag('doubles')) {
      this.startMatch('human', parseDifficulty(debugFlag('difficulty')), hasDebugFlag('doubles'));
    } else if (this.settings.playSeconds === 0 || portal.id === 'crazygames') {
      // Land straight in a match (portals ask for this): new players face Easy, with key hints on screen.
      const first = this.settings.playSeconds === 0;
      this.startMatch('human', first ? 'easy' : this.settings.difficulty, first ? false : undefined);
      this.world.hud.flash('First to 11!', 'info', 2200, 'Win by 2 · P for the menu');
    } else {
      this.showTitle();
    }

    // Debug: `?warp=6` fast-forwards 6 seconds of play before the first frame (for screenshots).
    const warp = Number(debugFlag('warp') ?? 0);
    for (let i = 0; i < warp * 60; i++) this.advance(1 / 60);
    this.lastFrameAt = performance.now();
    this.stage.renderer.setAnimationLoop(() => this.frame());
    this.keepOnlineRunningInBackground();
  }

  // ---------------------------------------------------------------- modes & screens

  private setMode(mode: GameMode): void {
    this.mode?.dispose?.();
    this.tracker = null;
    this.endReplay();
    this.replay.track([]);
    this.replayDue = null;
    // A fast-forwarded or slow-mo AI match must never carry its speed into the next mode.
    this.timeScale = 1;
    if (this.orbit) this.toggleOrbit();
    this.stage.grace();
    this.effects.setLanding(null);
    this.effects.setServeBox(null);
    this.mode = mode;
    this.world.ballView.clearTrail();
  }

  private setVenue(id: VenueId): void {
    if (id === this.venueId) return;
    this.venueId = id;
    this.venues?.apply(VENUES[id]);
  }

  private matchMode(near: Controller, far: Difficulty, doubles: boolean, rival?: number): MatchMode {
    const r = rival !== undefined ? RIVALS[rival] : null;
    const m = new MatchMode(this.world, this.template, this.scoreboard, {
      scoring: {
        ...DEFAULT_SCORING,
        mode: debugFlag('scoring') === 'rally' ? 'rally' : this.settings.scoring,
        teamSize: doubles ? 2 : 1,
        target: r ? r.target : DEFAULT_SCORING.target,
      },
      near,
      far,
      nearPalette: lookToPalette(this.settings.look),
      farPalette: r?.palette,
      farProfile: r?.profile,
      names: r ? ['YOU', r.name.toUpperCase()] : undefined,
    });
    this.scoreboard.setNames(m.names);
    m.onGameOver = (r) => this.showResults(r);
    return m;
  }

  private startMatch(near: Controller, far: Difficulty, doubles = this.settings.format === 'doubles'): void {
    this.current = { near, far, doubles };
    this.setVenue(this.settings.court);
    const m = this.matchMode(near, far, doubles);
    this.setMode(m);
    if (near === 'human') this.track(m, 0, { kind: 'quick', opponent: far });
    if (near === 'human') this.highlights(m);
    m.startCommentary();
    this.enterPlaying();
  }

  /** A flash of light over the whole screen (a big hit). */
  private screenFlash(amount: number): void {
    const el = this.flashEl;
    el.style.setProperty('--flash', String(Math.min(1, amount) * 0.55));
    el.classList.remove('go');
    void el.offsetWidth; // restart the animation
    el.classList.add('go');
  }

  /** Record this match so its best points get an instant replay. */
  private highlights(m: MatchMode): void {
    this.replay.track(m.replayNodes());
    if (hasDebugFlag('replays')) m.replayEveryPoint = true;
    m.onHighlight = () => {
      // Not too often: a replay every point would get in the way.
      if (!this.settings.replays || (performance.now() - this.lastReplayAt < 20000 && !hasDebugFlag('replays'))) return;
      this.replayDue = { from: this.time - 3.2, to: this.time + 0.8 };
    };
  }

  private startReplay(): void {
    const due = this.replayDue!;
    this.replayDue = null;
    if (!this.replay.start(due.from, due.to)) return;
    this.state = 'replay';
    this.replayStartedAt = performance.now();
    this.replaySide = Math.random() < 0.5 ? 1 : -1;
    this.replayLook.set(Number.NaN, 0, 0);
    this.effects.setLanding(null);
    this.world.ballView.clearTrail();
    this.replayUi.classList.remove('hidden');
    this.uiRoot.classList.add('replaying');
  }

  private endReplay(): void {
    if (!this.replay.playing && this.state !== 'replay') return;
    this.replay.stop();
    this.replayUi.classList.add('hidden');
    this.uiRoot.classList.remove('replaying');
    this.world.ballView.clearTrail();
    this.lastReplayAt = performance.now();
    if (this.state === 'replay') this.state = 'playing';
  }

  /** One frame of the replay: half speed, filmed from a TV camera on the sideline. */
  private stepReplay(dt: number): boolean {
    const b = this.replay.step(dt * 0.5);
    if (!b) {
      this.endReplay();
      return false;
    }
    this.world.ballView.update(b as unknown as Ball, dt * 0.5, this.cam.camera);
    const cam = this.cam.camera;
    const k = Number.isNaN(this.replayLook.x) ? 1 : 1 - Math.exp(-3 * dt);
    // Inside the fence (x 17), up high, sliding along the sideline with the ball but never
    // parked right behind the net post.
    let z = Math.max(-14, Math.min(14, b.pos.z * 0.6));
    if (Math.abs(z) < 6) z = 6 * (Math.sign(b.pos.z) || 1);
    const want = new THREE.Vector3(this.replaySide * 15.5, 8.5, z);
    if (k === 1) {
      cam.position.copy(want);
      this.replayLook.set(b.pos.x * 0.3, 1.5, b.pos.z * 0.85);
    } else cam.position.lerp(want, k);
    this.replayLook.lerp(new THREE.Vector3(b.pos.x * 0.3, 1.5 + b.pos.y * 0.2, b.pos.z * 0.85), k);
    cam.lookAt(this.replayLook);
    return true;
  }

  /** Count this match for coins, challenges and achievements. */
  private track(m: MatchMode | null, you: 0 | 1, ctx: MatchContext): void {
    this.tracker = this.progress.tracker(you, ctx);
    this.matchRewards = [];
    if (m) m.observer = this.tracker;
  }

  // ---------------------------------------------------------------- tournament

  private showTournament(): void {
    const s = this.settings;
    const wins = Math.min(s.tourneyWins, RIVALS.length);
    const champion = wins >= RIVALS.length;
    const rows = RIVALS.map((r, i) => {
      const cls = i < wins ? 'done' : i === wins ? 'next' : 'locked';
      const mark = i < wins ? '✓' : i === wins ? '▶' : '🔒';
      return `<div class="rival ${cls}"><span class="dot" style="background:${r.palette.shirt}"></span>
        <div>${i + 1}. ${r.name}<small>${i <= wins ? r.style : '???'} · ${VENUES[r.venue].name}</small></div><span class="mark">${mark}</span></div>`;
    }).join('');
    const next = champion ? RIVALS.length - 1 : wins;
    this.menu.show({
      variant: 'title',
      header: `<div class="menu-headline">${champion ? '🏆 Champion!' : 'Tournament'}</div>
        <div class="menu-sub">${champion ? 'You beat them all. Replay the final any time.' : 'Beat six rivals to win the Pickle Crown. Every win unlocks gear for your player.'}</div>
        <div class="rivals">${rows}</div>`,
      items: [
        { label: champion ? '▶ Replay the final' : `▶ Play ${RIVALS[next].name}`, primary: true, action: () => this.showRivalIntro(next) },
        { label: 'My Player', action: () => this.showMyPlayer(() => this.showTournament()) },
        { label: 'Back', action: () => this.showTitle() },
      ],
      back: () => this.showTitle(),
    });
  }

  private showRivalIntro(i: number): void {
    const r = RIVALS[i];
    this.menu.show({
      variant: 'title',
      header: `<div class="menu-sub">Match ${i + 1} of ${RIVALS.length} · ${VENUES[r.venue].name}</div>
        <div class="menu-headline">${r.name}</div>
        <div class="menu-sub">${r.style}</div>
        <div class="unlock">Tip: ${r.tip}</div>
        <div class="menu-sub">First to ${r.target} · Win to unlock: ${r.reward.label}</div>`,
      items: [
        { label: '▶ Start match', primary: true, action: () => this.startTournamentMatch(i) },
        { label: 'Back', action: () => this.showTournament() },
      ],
      back: () => this.showTournament(),
    });
  }

  private startTournamentMatch(i: number): void {
    this.current = { tournament: i };
    this.setVenue(RIVALS[i].venue);
    const m = this.matchMode('human', 'medium', false, i);
    this.setMode(m);
    this.track(m, 0, { kind: 'tournament', opponent: 'medium' });
    this.highlights(m);
    m.startCommentary();
    this.enterPlaying();
  }

  // ---------------------------------------------------------------- coins: shop, challenges

  /** Buy gear with coins. Bought items are worn straight away (shown on the model behind). */
  private showShop(room: ShowroomMode, back: () => void, focus = -1): void {
    const s = this.settings;
    const coins = this.progress.state.coins;
    const lists: [string, LookOptionList, keyof Look][] = [
      ['shirt', SHIRTS, 'shirt'],
      ['shorts', SHORTS, 'shorts'],
      ['cap', CAP_COLORS, 'cap'],
      ['paddle', PADDLES, 'paddle'],
    ];
    const items: MenuScreen['items'] = [];
    for (const [what, list, key] of lists) {
      list.forEach((o, i) => {
        if (!o.price || !o.unlock) return;
        const owned = s.unlocked.includes(o.unlock);
        const unlock = o.unlock;
        const price = o.price;
        const row = items.length;
        items.push({
          label: owned
            ? `${o.name} ${what} <span class="owned">✓ owned</span>`
            : `<span class="swatch" style="background:${o.color}"></span>${o.name} ${what} <span class="price${price > coins ? ' short' : ''}">${coinIcon()} ${price}</span>`,
          action: () => {
            if (!owned) {
              if (!this.progress.spend(price)) {
                this.world.hud.muted = false;
                this.world.hud.flash('Not enough coins', 'bad', 1400, 'Play matches and finish challenges to earn more');
                this.world.hud.muted = true;
                return;
              }
              s.unlocked.push(unlock);
              this.sound.play('click', { volume: 0.9, pitch: 1.6 });
            }
            s.look = { ...s.look, [key]: i };
            saveSettings(s);
            room.setPalette(lookToPalette(s.look));
            this.showShop(room, back, row);
          },
        });
      });
    }
    items.push({ label: 'Back', primary: focus < 0, action: () => this.showMyPlayer(back) });
    this.menu.show({
      variant: 'side',
      header: `<div class="menu-headline">Shop</div><div class="menu-sub">${coinIcon()} ${coins} coins · pick one to buy and wear it</div>`,
      items,
      focus,
      back: () => this.showMyPlayer(back),
    });
  }

  /** Today's three challenges and all achievements. */
  private showChallenges(): void {
    const p = this.progress;
    const d = p.state.daily;
    const daily = p.today
      .map((c, i) => {
        const done = d.done[i];
        const pct = Math.round((100 * d.progress[i]) / c.target);
        return `<div class="challenge${done ? ' done' : ''}"><div><b>${c.text}</b><small>${done ? 'Done!' : `${d.progress[i]} / ${c.target}`}</small>
          <div class="bar"><i style="width:${pct}%"></i></div></div><span class="price">${coinIcon()} ${c.reward}</span></div>`;
      })
      .join('');
    const got = new Set(p.state.achievements);
    const awards = ACHIEVEMENTS.map(
      (a) => `<div class="award${got.has(a.id) ? ' got' : ''}" title="${a.text}"><b>${got.has(a.id) ? '★' : '☆'} ${a.name}</b><small>${a.text} · ${coinIcon()} ${a.reward}</small></div>`,
    ).join('');
    this.menu.show({
      variant: 'title',
      header: `<div class="menu-headline">Daily Challenges</div><div class="menu-sub">New ones every day · ${coinIcon()} ${p.state.coins} coins</div>
        <div class="challenges">${daily}</div>
        <div class="menu-headline small">Achievements <small>${got.size}/${ACHIEVEMENTS.length}</small></div>
        <div class="awards">${awards}</div>`,
      items: [
        { label: '▶ Play vs AI', primary: true, action: () => this.showQuickPlay() },
        { label: 'Back', action: () => this.showTitle() },
      ],
      back: () => this.showTitle(),
    });
  }

  // ---------------------------------------------------------------- my player

  private showMyPlayer(back: () => void): void {
    const s = this.settings;
    this.state = 'title';
    this.touch?.setVisible(false);
    const room = new ShowroomMode(this.world, this.template, lookToPalette(s.look));
    this.setVenue(s.court);
    this.setMode(room);
    this.scoreboard.setVisible(false);
    this.world.hud.muted = true;
    const pick = <T extends { name: string; unlock?: string }>(label: string, list: T[], key: keyof Look) => {
      const idx = available(list, s.unlocked);
      return this.option(
        label,
        idx.map((i) => list[i].name),
        () => Math.max(0, idx.indexOf(s.look[key])),
        (i) => {
          s.look = { ...s.look, [key]: idx[i] };
          room.setPalette(lookToPalette(s.look));
        },
      );
    };
    const prizes = [PADDLES, SHIRTS, HEADWEAR, CAP_COLORS].flat() as { unlock?: string; price?: number }[];
    const locked = prizes.filter((o) => o.unlock && !o.price && !s.unlocked.includes(o.unlock)).length;
    this.menu.show({
      variant: 'side',
      header: `<div class="menu-headline">My Player</div>
        <div class="menu-sub">${coinIcon()} ${this.progress.state.coins} coins${locked ? ` · ${locked} prizes left in the Tournament` : ''}</div>`,
      items: [
        pick('Skin', SKIN_TONES, 'skin'),
        pick('Hair', HAIR_STYLES, 'hairStyle'),
        pick('Hair color', HAIR_COLORS, 'hair'),
        pick('Shirt', SHIRTS, 'shirt'),
        pick('Shorts', SHORTS, 'shorts'),
        pick('Headwear', HEADWEAR, 'headwear'),
        pick('Cap color', CAP_COLORS, 'cap'),
        pick('Paddle', PADDLES, 'paddle'),
        { label: `${coinIcon()} Shop`, action: () => this.showShop(room, back) },
        { label: 'Done', primary: true, action: back },
      ],
      back,
    });
  }

  private startPractice(): void {
    this.current = 'practice';
    this.setVenue(this.settings.court);
    this.setMode(new PracticeMode(this.world, this.template, undefined, lookToPalette(this.settings.look)));
    this.enterPlaying();
  }

  private startTutorial(): void {
    this.current = 'tutorial';
    this.setVenue('park');
    const t = new TutorialMode(this.world, this.template, this.uiRoot, !!this.touch, lookToPalette(this.settings.look));
    t.onComplete = () => this.tutorialFinished();
    this.setMode(t);
    this.enterPlaying();
    this.scoreboard.setVisible(false);
  }

  private tutorialFinished(): void {
    this.settings.tutorialDone = true;
    saveSettings(this.settings);
    this.progress.achieve('tutorial');
    this.state = 'results';
    this.touch?.setVisible(false);
    this.sound.setMusic('menu');
    const s = this.settings;
    this.menu.show({
      header: `<div class="menu-headline">You're ready!</div><div class="menu-sub">Time to play a real match.</div>`,
      items: [
        { label: '▶ Play vs AI', primary: true, action: () => this.startMatch('human', s.difficulty) },
        this.option('Difficulty', LEVELS.map(cap), () => LEVELS.indexOf(s.difficulty), (i) => (s.difficulty = LEVELS[i])),
        { label: 'Main menu', action: () => this.showTitle() },
      ],
    });
  }

  // ---------------------------------------------------------------- online

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  private nameField(): string {
    return `<div class="menu-label">Your name</div>
      <input class="menu-input" id="kc-name" maxlength="14" autocomplete="nickname" placeholder="Player" value="${this.escape(this.settings.name)}">`;
  }

  /** Reads and saves the name box; falls back to "Player". */
  private readName(): string {
    const el = document.getElementById('kc-name') as HTMLInputElement | null;
    if (el) {
      this.settings.name = el.value.trim().slice(0, 14);
      saveSettings(this.settings);
    }
    return this.settings.name || 'Player';
  }

  private showOnline(error = ''): void {
    this.menu.show({
      variant: 'title',
      header: `<div class="menu-headline">Play Online</div>
        <div class="menu-sub">Play a friend, 1 on 1. One of you creates a match and sends the code.</div>
        ${error ? `<div class="menu-error">${this.escape(error)}</div>` : ''}
        ${this.nameField()}`,
      items: [
        { label: '▶ Create match', primary: true, action: () => void this.createOnline() },
        { label: 'Join with a code', action: () => this.showJoin('') },
        { label: 'Back', action: () => this.showTitle() },
      ],
      back: () => this.showTitle(),
    });
  }

  private async createOnline(): Promise<void> {
    const name = this.readName();
    this.menu.show({ variant: 'title', header: '<div class="menu-headline">Creating match<span class="waiting-dots"></span></div>', items: [] });
    let room: Room;
    try {
      const { Room } = await import('../net/room');
      room = await Room.create(name);
    } catch (e) {
      this.showOnline(e instanceof Error ? e.message : "Couldn't reach the server. Check your connection.");
      return;
    }
    this.room = room;
    console.info(`[KC] room ${room.code}`);
    const link = `${location.origin}${location.pathname}?join=${room.code}`;
    const cancel = () => {
      room.close();
      this.room = null;
      this.showOnline();
    };
    this.menu.show({
      variant: 'title',
      header: `<div class="menu-headline">Send this to a friend</div>
        <div class="room-code">${room.code}</div>
        <div class="invite">${link}</div>
        <div class="menu-sub">Waiting for your friend to join<span class="waiting-dots"></span></div>`,
      items: [
        {
          label: typeof navigator.share === 'function' ? 'Share invite link' : 'Copy invite link',
          primary: true,
          action: () => {
            const text = `Play Dinkzilla with me! ${link}`;
            const nav: Navigator = navigator;
            if (typeof nav.share === 'function') void nav.share({ title: 'Dinkzilla', text, url: link }).catch(() => {});
            else void nav.clipboard?.writeText(link).then(() => this.world.hud.flash('Link copied!', 'good', 900));
          },
        },
        { label: 'Cancel', action: cancel },
      ],
      back: cancel,
    });
    // The menu hides the HUD, so flash the copy confirmation over it.
    this.world.hud.muted = false;
    const guestName = await room.waitForGuest();
    if (this.room !== room) return;
    this.menu.show({ variant: 'title', header: `<div class="menu-headline">${this.escape(guestName)} joined!</div><div class="menu-sub">Connecting<span class="waiting-dots"></span></div>`, items: [] });
    const channel = await room.connect();
    const host = new OnlineHost(this.world, this.template, this.scoreboard, channel, name, guestName, {
      ...DEFAULT_SCORING,
      mode: this.settings.scoring,
    }, this.settings.court);
    this.setVenue(this.settings.court);
    host.match.onGameOver = (r) => this.showResults(r);
    host.onGone = () => this.friendLeft();
    room.onGone = () => this.friendLeft();
    this.current = 'online';
    this.scoreboard.setNames(host.match.names);
    this.setMode(host);
    this.track(host.match, 0, { kind: 'online', opponent: 'medium' });
    host.match.startCommentary();
    this.enterPlaying();
    this.world.hud.flash('Connected!', 'good', 1200, channel.kind === 'p2p' ? 'Direct connection' : 'Relayed connection (a bit slower)');
    console.info(`[KC] host connected via ${channel.kind}`);
  }

  private showJoin(code: string, error = ''): void {
    const join = () => {
      const el = document.getElementById('kc-code') as HTMLInputElement | null;
      void this.joinOnline((el?.value ?? '').replace(/\D/g, ''));
    };
    this.menu.show({
      variant: 'title',
      header: `<div class="menu-headline">Join a match</div>
        ${error ? `<div class="menu-error">${this.escape(error)}</div>` : ''}
        ${this.nameField()}
        <div class="menu-label">Match code</div>
        <input class="menu-input code" id="kc-code" inputmode="numeric" maxlength="5" placeholder="•••••" value="${this.escape(code)}">`,
      items: [
        { label: '▶ Join', primary: true, action: join },
        { label: 'Back', action: () => this.showOnline() },
      ],
      back: () => this.showOnline(),
    });
    const input = document.getElementById('kc-code') as HTMLInputElement | null;
    input?.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    if (!code) input?.focus();
  }

  private async joinOnline(code: string): Promise<void> {
    if (code.length !== 5) {
      this.showJoin(code, 'Match codes are 5 digits.');
      return;
    }
    const name = this.readName();
    this.menu.show({ variant: 'title', header: '<div class="menu-headline">Joining<span class="waiting-dots"></span></div>', items: [] });
    try {
      const { Room } = await import('../net/room');
      const { room, hostName } = await Room.join(code, name);
      this.room = room;
      this.menu.show({ variant: 'title', header: `<div class="menu-headline">Connecting to ${this.escape(hostName)}<span class="waiting-dots"></span></div>`, items: [] });
      const channel = await room.connect();
      const guest = new OnlineGuest(this.world, this.template, this.scoreboard, channel, hostName);
      guest.onGameOver = (r) => this.showResults(r);
      guest.onNewGame = () => {
        this.track(null, 1, { kind: 'online', opponent: 'medium' });
        this.enterPlaying();
      };
      guest.onGone = () => this.friendLeft();
      guest.onVenue = (id) => id in VENUES && this.setVenue(id as VenueId);
      room.onGone = () => this.friendLeft();
      this.current = 'online';
      this.setMode(guest);
      this.track(null, 1, { kind: 'online', opponent: 'medium' });
      this.enterPlaying();
      console.info(`[KC] guest connected via ${channel.kind}`);
      this.world.hud.flash('Connected!', 'good', 1200, channel.kind === 'p2p' ? 'Direct connection' : 'Relayed connection (a bit slower)');
    } catch (e) {
      this.room?.close();
      this.room = null;
      this.showJoin(code, e instanceof Error ? e.message : "Couldn't reach the server. Check your connection.");
    }
  }

  private leaveOnline(): void {
    const m = this.mode as unknown as { leave?: () => void };
    m.leave?.();
    this.room?.close();
    this.room = null;
    this.showTitle();
  }

  private friendLeft(): void {
    if (!this.room) return;
    this.room.close();
    this.room = null;
    this.showTitle();
    this.world.hud.muted = false;
    this.world.hud.flash('Your friend left', 'info', 2200, 'The online match has ended.');
    this.world.hud.muted = true;
  }

  private restart(): void {
    if (this.current === 'online') {
      if (this.mode instanceof OnlineHost) {
        this.track(this.mode.match, 0, { kind: 'online', opponent: 'medium' });
        this.mode.rematch();
        this.enterPlaying();
      }
      return;
    }
    if (this.current === 'tutorial') this.startTutorial();
    else if (this.current === 'practice') this.startPractice();
    else if ('tournament' in this.current) this.startTournamentMatch(this.current.tournament);
    else this.startMatch(this.current.near, this.current.far, this.current.doubles);
  }

  private enterPlaying(): void {
    this.state = 'playing';
    this.matchClock = 0;
    portal.gameplayStart();
    this.menu.hide();
    this.touch?.setVisible(true);
    this.world.hud.muted = false;
    this.scoreboard.setVisible(this.mode instanceof MatchMode);
    this.sound.setMusic('match');
  }

  /** Title screen, with a CPU match playing behind it. */
  private showTitle(): void {
    this.state = 'title';
    portal.gameplayStop();
    this.touch?.setVisible(false);
    this.setVenue(this.settings.court);
    this.setMode(this.matchMode('medium', 'hard', this.settings.format === 'doubles'));
    this.world.hud.muted = true;
    this.scoreboard.setVisible(false);
    this.sound.setMusic('menu');
    const s = this.settings;
    this.menu.show({
      variant: 'title',
      header: `<div class="coin-badge">${coinIcon()} ${this.progress.state.coins}</div><div class="logo">DINK<span class="accent">ZILLA!</span></div><div class="tagline">Arcade Pickleball</div>`,
      items: [
        { label: '▶ Play vs AI', primary: s.tutorialDone, action: () => this.showQuickPlay() },
        { label: `🏆 Tournament${s.tourneyWins >= RIVALS.length ? ' ✓' : s.tourneyWins ? ` (${s.tourneyWins}/${RIVALS.length})` : ''}`, action: () => this.showTournament() },
        { label: 'Play Online', action: () => this.showOnline() },
        { label: `Challenges (${this.progress.state.daily.done.filter(Boolean).length}/3 today)`, action: () => this.showChallenges() },
        { label: 'My Player & Shop', action: () => this.showMyPlayer(() => this.showTitle()) },
        {
          label: s.tutorialDone ? 'How to Play' : '★ How to Play (new? start here)',
          primary: !s.tutorialDone,
          action: () => this.startTutorial(),
        },
        { label: 'Watch AI vs AI', action: () => this.showWatchSetup() },
        { label: 'Practice', action: () => this.startPractice() },
        { label: 'Settings', action: () => this.showSettings(() => this.showTitle()) },
      ],
    });
  }

  /** Play vs AI: pick singles/doubles, difficulty and court, then go. */
  private showQuickPlay(): void {
    const s = this.settings;
    this.menu.show({
      variant: 'title',
      header: '<div class="menu-headline">Play vs AI</div>',
      items: [
        this.option('Mode', ['Singles', 'Doubles'], () => (s.format === 'doubles' ? 1 : 0), (i) => (s.format = i ? 'doubles' : 'singles')),
        this.option('Difficulty', LEVELS.map(cap), () => LEVELS.indexOf(s.difficulty), (i) => (s.difficulty = LEVELS[i])),
        this.option('Court', VENUE_ORDER.map((v) => VENUES[v].name), () => VENUE_ORDER.indexOf(s.court), (i) => (s.court = VENUE_ORDER[i])),
        { label: '▶ Start', primary: true, action: () => this.startMatch('human', s.difficulty) },
        { label: 'Back', action: () => this.showTitle() },
      ],
      back: () => this.showTitle(),
    });
  }

  private showWatchSetup(): void {
    const s = this.settings;
    this.menu.show({
      variant: 'title',
      header: '<div class="menu-headline">Watch AI vs AI</div><div class="menu-sub">F fast-forwards · P for the menu</div>',
      items: [
        this.option('Mode', ['Singles', 'Doubles'], () => (s.format === 'doubles' ? 1 : 0), (i) => (s.format = i ? 'doubles' : 'singles')),
        this.option('Orange team', LEVELS.map(cap), () => LEVELS.indexOf(s.watchNear), (i) => (s.watchNear = LEVELS[i])),
        this.option('Purple team', LEVELS.map(cap), () => LEVELS.indexOf(s.watchFar), (i) => (s.watchFar = LEVELS[i])),
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
        this.option('Announcer', ['Off', 'On'], () => (s.announcer ? 1 : 0), (i) => (s.announcer = !!i)),
        this.option('Replays', ['Off', 'On'], () => (s.replays ? 1 : 0), (i) => (s.replays = !!i)),
        this.option('Graphics', ['Standard', 'High'], () => (s.graphics === 'high' ? 1 : 0), (i) => (s.graphics = i ? 'high' : 'standard')),
        { label: 'Privacy policy', action: () => window.open('privacy.html', '_blank', 'noopener') },
        { label: 'Back', primary: true, action: back },
      ],
      back,
    });
  }

  private showPause(): void {
    this.state = 'paused';
    portal.gameplayStop();
    this.touch?.setVisible(false);
    this.sound.setMusic('menu');
    if (this.current === 'online') {
      this.menu.show({
        header: '<div class="menu-headline">Menu</div><div class="menu-sub">The match keeps going while you\'re here.</div>',
        items: [
          { label: '▶ Back to the match', primary: true, action: () => this.enterPlaying() },
          { label: 'Settings', action: () => this.showSettings(() => this.showPause()) },
          { label: 'Leave match', action: () => this.leaveOnline() },
        ],
        back: () => this.enterPlaying(),
      });
      return;
    }
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
    portal.gameplayStop();
    // a match is a natural break: portals may show an ad here (offline matches are frozen on results)
    if (!this.mode?.online) void portal.commercialBreak();
    this.touch?.setVisible(false);
    this.sound.setMusic('menu');
    const youWon = r.humanTeam && r.winner === (r.youTeam ?? 0);
    const headline = youWon ? 'YOU WIN!' : r.humanTeam ? 'SO CLOSE!' : `${r.names[r.winner]} WINS`;
    // Tournament: a win against the next rival advances you and unlocks gear.
    let unlockLine = '';
    let tourneyItems: MenuScreen['items'] | null = null;
    const cur = this.current;
    if (typeof cur === 'object' && 'tournament' in cur) {
      const i = cur.tournament;
      const s = this.settings;
      if (youWon && i === s.tourneyWins) {
        s.tourneyWins = i + 1;
        for (const id of rewardsFor(i)) if (!s.unlocked.includes(id)) s.unlocked.push(id);
        saveSettings(s);
        unlockLine = `<div class="unlock">Unlocked: ${RIVALS[i].reward.label}! Try it on in My Player.</div>`;
        if (s.tourneyWins >= RIVALS.length) {
          unlockLine += '<div class="unlock">🏆 You are the Pickle Champion!</div>';
          this.progress.achieve('champion');
        }
      }
      tourneyItems = [
        youWon && i + 1 < RIVALS.length
          ? { label: `▶ Next: ${RIVALS[i + 1].name}`, primary: true, action: () => this.showRivalIntro(i + 1) }
          : { label: youWon ? '▶ Tournament' : '▶ Try again', primary: true, action: () => (youWon ? this.showTournament() : this.startTournamentMatch(i)) },
        { label: 'My Player', action: () => this.showMyPlayer(() => this.showTournament()) },
        { label: 'Tournament', action: () => this.showTournament() },
      ];
    }
    // Coins for the match (and any challenges/achievements it finished).
    let earned = 0;
    let doubled = false;
    let adBusy = false;
    const extras = this.matchRewards.map((t) => `<div class="reward">★ ${this.escape(t)}</div>`).join('');
    if (this.tracker) {
      earned = this.tracker.finish(r, !!youWon);
      this.tracker = null;
    }
    const coinLine = () =>
      earned
        ? `<div class="coin-earned">${coinIcon()} +${doubled ? earned * 2 : earned} coins${doubled ? ' <b class="doubled">×2</b>' : ''} <small>· ${this.progress.state.coins} total</small></div>${extras}`
        : '';
    // On a game portal: watch an ad (your choice) to double the coins from this match.
    const adItem = (): MenuScreen['items'] =>
      portal.active && earned > 0 && !doubled && this.current !== 'online'
        ? [
            {
              label: `🎬 Watch an ad: double coins (+${earned})`,
              action: async () => {
                if (adBusy) return;
                adBusy = true;
                const ok = await portal.rewardedBreak();
                adBusy = false;
                if (!ok) {
                  this.world.hud.flash('No ad right now', 'info', 1400, 'Try again after your next match');
                  return;
                }
                doubled = true;
                this.progress.addCoins(earned);
                this.sound.play('click', { volume: 0.9, pitch: 1.6 });
                this.menu.show(screen());
              },
            },
          ]
        : [];
    const stats = [
      ['Rallies won', `${r.ralliesWon[0]}–${r.ralliesWon[1]}`],
      ['Longest rally', `${r.longestRally} shots`],
      ...(r.humanTeam ? [['Perfect hits', String(r.perfects)]] : []),
    ]
      .map(([k, v]) => `<div><b>${v}</b>${k}</div>`)
      .join('');
    const screen = (): MenuScreen => ({
      header: `<div class="menu-headline">${headline}</div>
        <div class="result-score">${r.points[0]} – ${r.points[1]}</div>
        <div class="menu-sub">${r.names[0]} vs ${r.names[1]}</div>
        <div class="result-stats">${stats}</div>${coinLine()}${unlockLine}`,
      items: tourneyItems ? [tourneyItems[0], ...adItem(), ...tourneyItems.slice(1)] : (
        this.current === 'online'
          ? this.mode instanceof OnlineHost
            ? [
                { label: '▶ Rematch', primary: true, action: () => this.restart() },
                { label: 'Leave match', action: () => this.leaveOnline() },
              ]
            : [{ label: 'Leave match', action: () => this.leaveOnline() }]
          : [
        { label: '▶ Rematch', primary: true, action: () => this.restart() },
        ...adItem(),
        { label: 'Main menu', action: () => this.showTitle() },
      ]),
    });
    this.menu.show(screen());
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
    this.sound.setMuted(portal.muted);
    saveSettings(s);
    this.cam.setPreset(s.camera);
    this.sound.setVolumes(s.sfxVolume, s.musicVolume);
    this.sound.announcer = s.announcer;
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
    netStats.frames++;
    if (now - this.fpsFrom >= 1000) {
      netStats.fps = ((netStats.frames - this.fpsFrames) * 1000) / (now - this.fpsFrom);
      this.fpsFrom = now;
      this.fpsFrames = netStats.frames;
    }
    // Online, a hitch on one computer must not slow the shared match down, so catch up more.
    const dt = Math.min((now - this.lastFrameAt) / 1000, this.mode?.online ? 0.25 : 0.1);
    this.lastFrameAt = now;
    this.advance(dt);
    // The title art covers the 3D scene, so don't spend the GPU drawing it.
    const covered = this.state === 'title' && this.titleArt !== null && this.menu.open && !this.mode?.cameraPose;
    if (!covered) this.stage.render(this.cam.camera);
    this.stage.adaptQuality(dt, now);
    this.world.keys.endFrame();
  }

  /**
   * Browsers stop drawing frames in a hidden tab (another tab in front, window minimized), which
   * would freeze an online match for BOTH players. A tiny worker keeps ticking (worker timers
   * aren't put to sleep the same way), and while the page is hidden during an online match each
   * tick runs the game logic without drawing.
   */
  private keepOnlineRunningInBackground(): void {
    if (typeof Worker === 'undefined' || typeof document === 'undefined') return;
    let worker: Worker;
    try {
      const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=e.data?setInterval(()=>postMessage(0),16):null;};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch {
      return;
    }
    worker.onmessage = () => {
      if (!document.hidden || !this.mode?.online) return;
      const now = performance.now();
      const dt = Math.min((now - this.lastFrameAt) / 1000, 0.25);
      this.lastFrameAt = now;
      netStats.bgTicks++;
      this.advance(dt);
      this.world.keys.endFrame();
    };
    const sync = () => worker.postMessage(document.hidden);
    document.addEventListener('visibilitychange', sync);
    sync();
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

    // You can't pause a friend: online matches keep running behind the menu.
    const frozen = (this.state === 'paused' || this.state === 'results' || this.state === 'replay') && !this.mode?.online;
    const stopped = this.freeze > 0;
    this.freeze = Math.max(0, this.freeze - dt);
    const gameDt = frozen || stopped ? 0 : dt * this.timeScale;
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
    const replaying = this.state === 'replay' && this.stepReplay(dt);
    if (!replaying) ballView.update(ball, gameDt, this.cam.camera);
    if (this.state === 'playing' && gameDt > 0) {
      this.replay.record(this.time, ball);
      if (this.replayDue && this.time >= this.replayDue.to) this.startReplay();
    }
    this.effects.update(dt, this.cam.camera);
    // Low-end devices animate the crowd at half rate (hundreds of fans, all on the CPU).
    if (!this.stage.lite || (this.crowdTick = !this.crowdTick)) this.crowd.update(this.time, this.stage.lite ? gameDt * 2 : gameDt);
    this.venues?.update(this.time);

    if (replaying) {
      // the replay placed the camera
    } else if (mode.cameraPose?.(this.cam.camera, dt)) {
      // the mode placed the camera
    } else if (hasDebugFlag('crowdcam')) {
      // Test hook: close-up of the side bleachers, with the crowd cheering.
      this.crowd.cheer(debugFlag('crowdcam') === 'clap' ? 0.4 : 1);
      this.cam.camera.position.set(-10, 9, -6);
      this.cam.camera.lookAt(-23, 3.5, -12);
    } else if (this.orbit) this.orbit.update();
    else if (this.state === 'title') this.cam.orbit(dt);
    else this.cam.update(dt, mode.cameraTargetX(), mode.cameraSide?.() ?? 1);

    // The full info panel is for development; players get one short line at most.
    if (this.court) hideFenceBehind(this.court, this.cam.camera);
    hud.setPanel(hasDebugFlag('debug') ? mode.describe() + this.statusLine() : mode.cornerText?.() ?? '');
    this.updateCoach(dt);
  }

  /** Key-cap hints: the serve keys when it's your serve, all the controls while you're new. */
  private updateCoach(dt: number): void {
    const cur = this.current;
    const human = cur !== 'tutorial' && !(typeof cur === 'object' && 'near' in cur && cur.near !== 'human');
    if (this.state !== 'playing' || this.menu.open || !human) {
      this.coach.show(null);
      return;
    }
    this.matchClock += dt;
    const before = Math.floor(this.settings.playSeconds / 5);
    this.settings.playSeconds += dt;
    if (Math.floor(this.settings.playSeconds / 5) !== before) saveSettings(this.settings);
    const learning = this.settings.playSeconds < 120 || this.matchClock < 5;
    this.coach.show(this.mode?.yourServe?.() ? 'serve' : learning ? 'controls' : null);
  }

  /** Paddle "pop": louder for harder hits, panned to where it was struck. */
  private hitSound(): void {
    const b = this.world.ball;
    const pos = b.pos.clone();
    const moving = b.vel.lengthSq() > 0;
    const power = Math.min(1, b.vel.length() / 60);
    this.playHit(pos, power, moving, 1);
    this.replay.event(this.time, () => this.playHit(pos, power, moving, 0.8));
  }

  /** `rate` < 1 for the slowed-down replay. */
  private playHit(pos: THREE.Vector3, power: number, moving: boolean, rate: number): void {
    if (moving) {
      this.effects.burst(pos, power, false);
      if (power > 0.85 && this.state !== 'title') this.cam.shake(0.35 * power);
    }
    this.sound.play('paddle', {
      volume: this.spatial(pos) * (0.45 + 0.55 * power),
      pitch: (1.04 + Math.random() * 0.14 + power * 0.1) * rate,
      pan: pos.x / 14,
    });
  }

  private ballSound(e: BallEvent): void {
    this.playBallEvent(e, 1);
    this.replay.event(this.time, () => this.playBallEvent(e, 0.8));
  }

  private playBallEvent(e: BallEvent, rate: number): void {
    const pos = new THREE.Vector3(e.x, e.y, e.z);
    if (e.type === 'bounce') {
      this.world.ballView.squash(e.speed);
      if (e.speed > 22 && this.state !== 'title') this.effects.impact(pos, Math.min(1, (e.speed - 22) / 30));
      this.sound.play('bounce', { volume: this.spatial(pos) * Math.min(1, 0.2 + e.speed / 30), pitch: (0.95 + Math.random() * 0.1) * rate, pan: e.x / 14 });
    } else {
      this.sound.play('net', { volume: e.type === 'net' ? 0.9 : 0.5, pan: e.x / 14, pitch: rate });
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
    // Speed and camera hotkeys: only when watching AI vs AI (or with ?debug), never online.
    // F sits next to WASD and C is a shot key, so these used to fire by accident mid-match.
    const cur = this.current;
    const watching = typeof cur === 'object' && 'near' in cur && cur.near !== 'human' && this.state === 'playing';
    if (this.mode?.online || !(watching || hasDebugFlag('debug'))) return;
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
    return `<div class="dim"><b>P</b> Pause ${flags.join(' ')}</div>`;
  }
}
