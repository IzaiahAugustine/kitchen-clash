import * as THREE from 'three';
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
import { loadCourt } from '../render/courtView';
import { Crowd } from '../render/crowd';
import { Effects } from '../render/effects';
import { Stage } from '../render/stage';
import { DEFAULT_SCORING } from '../rules/scoring';
import { Hud } from '../ui/hud';
import { Menu, type MenuScreen } from '../ui/menu';
import { Scoreboard } from '../ui/scoreboard';
import { debugFlag, hasDebugFlag } from './debugFlags';
import { MatchMode, type Controller, type MatchResult } from './matchMode';
import type { GameMode, World } from './mode';
import { PracticeMode } from './practiceMode';
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
        hitstop: (s) => (this.freeze = Math.max(this.freeze, s)),
      },
    };
    this.scoreboard = new Scoreboard(this.uiRoot, ['YOU', 'CPU'], ['#ff6b35', '#7b2ff7']);
    this.world.hud.projector = (p) => {
      const v = p.clone().project(this.cam.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
      return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
    };
    this.menu = new Menu(this.uiRoot);
    this.menu.onNavigate = () => this.sound.play('click', { volume: 0.5 });
    // Phones and tablets get on-screen controls (`?touch` forces them for testing).
    if (isTouchDevice() || hasDebugFlag('touch')) {
      this.touch = new TouchControls(this.uiRoot);
      this.world.controls.touch = this.touch;
      this.menu.touch = true;
      document.body.classList.add('touch');
    }
    this.applySettings();
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
    this.venues = new VenueDresser(this.stage.scene, court, this.stage.hemi, this.stage.sun, this.stage.renderer);
    // Debug: `?court=beach` picks the court for this session.
    const court0 = debugFlag('court');
    if (court0 && court0 in VENUES) this.settings.court = court0 as VenueId;
    this.setVenue(this.settings.court);
    void this.findTitleArt();

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
    this.setMode(this.matchMode(near, far, doubles));
    this.enterPlaying();
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
    this.setMode(this.matchMode('human', 'medium', false, i));
    this.enterPlaying();
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
    const locked = PADDLES.length + SHIRTS.length + HEADWEAR.length + CAP_COLORS.length -
      [PADDLES, SHIRTS, HEADWEAR, CAP_COLORS].reduce((n, l) => n + available(l as { unlock?: string }[], s.unlocked).length, 0);
    this.menu.show({
      variant: 'side',
      header: `<div class="menu-headline">My Player</div>
        <div class="menu-sub">${locked ? `${locked} more items to unlock in the Tournament` : 'Everything unlocked!'}</div>`,
      items: [
        pick('Skin', SKIN_TONES, 'skin'),
        pick('Hair', HAIR_STYLES, 'hairStyle'),
        pick('Hair color', HAIR_COLORS, 'hair'),
        pick('Shirt', SHIRTS, 'shirt'),
        pick('Shorts', SHORTS, 'shorts'),
        pick('Headwear', HEADWEAR, 'headwear'),
        pick('Cap color', CAP_COLORS, 'cap'),
        pick('Paddle', PADDLES, 'paddle'),
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
    this.state = 'results';
    this.touch?.setVisible(false);
    this.sound.setMusic(true);
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
            const text = `Play Kitchen Clash with me! ${link}`;
            const nav: Navigator = navigator;
            if (typeof nav.share === 'function') void nav.share({ title: 'Kitchen Clash', text, url: link }).catch(() => {});
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
      guest.onNewGame = () => this.enterPlaying();
      guest.onGone = () => this.friendLeft();
      guest.onVenue = (id) => id in VENUES && this.setVenue(id as VenueId);
      room.onGone = () => this.friendLeft();
      this.current = 'online';
      this.setMode(guest);
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
    portal.gameplayStart();
    this.menu.hide();
    this.touch?.setVisible(true);
    this.world.hud.muted = false;
    this.scoreboard.setVisible(this.mode instanceof MatchMode);
    this.sound.setMusic(false);
    this.sound.setAmbience(true);
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
    this.sound.setMusic(true);
    this.sound.setAmbience(true);
    const s = this.settings;
    this.menu.show({
      variant: 'title',
      header: `<div class="logo">KITCHEN<span class="clash">CLASH!</span></div><div class="tagline">Arcade Pickleball</div>`,
      items: [
        { label: '▶ Play vs AI', primary: s.tutorialDone, action: () => this.showQuickPlay() },
        { label: `🏆 Tournament${s.tourneyWins >= RIVALS.length ? ' ✓' : s.tourneyWins ? ` (${s.tourneyWins}/${RIVALS.length})` : ''}`, action: () => this.showTournament() },
        { label: 'Play Online', action: () => this.showOnline() },
        { label: 'My Player', action: () => this.showMyPlayer(() => this.showTitle()) },
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
      header: '<div class="menu-headline">Watch AI vs AI</div><div class="menu-sub">F fast-forwards · Esc for the menu</div>',
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
    this.sound.setMusic(true);
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
    this.sound.setMusic(true);
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
        if (s.tourneyWins >= RIVALS.length) unlockLine += '<div class="unlock">🏆 You are the Pickle Champion!</div>';
      }
      tourneyItems = [
        youWon && i + 1 < RIVALS.length
          ? { label: `▶ Next: ${RIVALS[i + 1].name}`, primary: true, action: () => this.showRivalIntro(i + 1) }
          : { label: youWon ? '▶ Tournament' : '▶ Try again', primary: true, action: () => (youWon ? this.showTournament() : this.startTournamentMatch(i)) },
        { label: 'My Player', action: () => this.showMyPlayer(() => this.showTournament()) },
        { label: 'Tournament', action: () => this.showTournament() },
      ];
    }
    const stats = [
      ['Rallies won', `${r.ralliesWon[0]}–${r.ralliesWon[1]}`],
      ['Longest rally', `${r.longestRally} shots`],
      ...(r.humanTeam ? [['Perfect hits', String(r.perfects)]] : []),
    ]
      .map(([k, v]) => `<div><b>${v}</b>${k}</div>`)
      .join('');
    const screen: MenuScreen = {
      header: `<div class="menu-headline">${headline}</div>
        <div class="result-score">${r.points[0]} – ${r.points[1]}</div>
        <div class="menu-sub">${r.names[0]} vs ${r.names[1]}</div>
        <div class="result-stats">${stats}</div>${unlockLine}`,
      items: tourneyItems ?? (
        this.current === 'online'
          ? this.mode instanceof OnlineHost
            ? [
                { label: '▶ Rematch', primary: true, action: () => this.restart() },
                { label: 'Leave match', action: () => this.leaveOnline() },
              ]
            : [{ label: 'Leave match', action: () => this.leaveOnline() }]
          : [
        { label: '▶ Rematch', primary: true, action: () => this.restart() },
        { label: 'Main menu', action: () => this.showTitle() },
      ]),
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
    this.sound.setMuted(portal.muted);
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
    const frozen = (this.state === 'paused' || this.state === 'results') && !this.mode?.online;
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
    ballView.update(ball, gameDt, this.cam.camera);
    this.effects.update(dt, this.cam.camera);
    this.crowd.update(this.time, gameDt);

    if (mode.cameraPose?.(this.cam.camera, dt)) {
      // the mode placed the camera
    } else if (hasDebugFlag('crowdcam')) {
      // Test hook: close-up of the side bleachers, with the crowd cheering.
      this.crowd.cheer(debugFlag('crowdcam') === 'clap' ? 0.4 : 1);
      this.cam.camera.position.set(-10, 9, -6);
      this.cam.camera.lookAt(-23, 3.5, -12);
    } else if (this.orbit) this.orbit.update();
    else if (this.state === 'title') this.cam.orbit(dt);
    else this.cam.update(dt, mode.cameraTargetX(), mode.cameraSide?.() ?? 1);

    hud.setPanel(mode.describe() + this.statusLine());
  }

  /** Paddle "pop": louder for harder hits, panned to where it was struck. */
  private hitSound(): void {
    const b = this.world.ball;
    const power = Math.min(1, b.vel.length() / 60);
    if (b.vel.lengthSq() > 0) {
      this.effects.burst(b.pos, power, false);
      if (power > 0.85 && this.state !== 'title') this.cam.shake(0.35 * power);
    }
    this.sound.play('paddle', {
      volume: this.spatial(b.pos) * (0.45 + 0.55 * power),
      pitch: 0.92 + Math.random() * 0.16 + power * 0.08,
      pan: b.pos.x / 14,
    });
  }

  private ballSound(e: BallEvent): void {
    const pos = new THREE.Vector3(e.x, e.y, e.z);
    if (e.type === 'bounce') {
      this.world.ballView.squash(e.speed);
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
    return `<div class="dim"><b>Esc</b> / <b>P</b> Pause ${flags.join(' ')}</div>`;
  }
}
