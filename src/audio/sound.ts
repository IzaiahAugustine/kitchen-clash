/**
 * Sound effects, announcer and music with the Web Audio API.
 *
 * Each sound first tries files in public/audio: <name>_1, <name>_2… (variations, one picked at
 * random each time) or plain <name>, as .mp3/.wav/.m4a/.ogg/.aac. Without a file it falls back
 * to a synthesized version so the game is never silent.
 * Music (public/audio/music.* for menus, match.* during play) and the announcer (vo_*) only
 * play from files.
 */

export type SoundName = 'paddle' | 'bounce' | 'net' | 'click';
/** Announcer call-outs (public/audio/vo_<name>). */
export type VoiceLine =
  | 'ace'
  | 'rally'
  | 'smash'
  | 'great'
  | 'matchpoint'
  | 'win'
  | 'lose'
  | 'sideout'
  | 'welcome'
  | 'onfire'
  | 'tied'
  | 'kitchen'
  | 'unbelievable'
  | 'comeback'
  | 'boss'
  | 'zilla';
const VOICE_LINES: VoiceLine[] = ['ace', 'rally', 'smash', 'great', 'matchpoint', 'win', 'lose', 'sideout', 'welcome', 'onfire', 'tied', 'kitchen', 'unbelievable', 'comeback', 'boss', 'zilla'];
export type MusicTrack = 'menu' | 'match';
const FILE_SOUNDS: string[] = ['paddle', 'bounce', 'net', 'click', 'music', 'match', ...VOICE_LINES.map((v) => `vo_${v}`)];
const EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', 'aac'];
/** The match track is 120 bpm: after its 16-second intro it loops 32 bars (64 s), skipping the outro. */
const MATCH_LOOP = { start: 16.04, end: 80.04 };
/** Match music sits lower than menu music, under the game sounds. */
const LEVEL: Record<MusicTrack, number> = { menu: 0.55, match: 0.3 };

export interface PlayOptions {
  /** 0..1 */
  volume?: number;
  /** Playback rate (1 = normal). */
  pitch?: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private sfxGain!: GainNode;
  private musicGain!: GainNode;
  private buffers = new Map<string, AudioBuffer[]>();
  private noise: AudioBuffer | null = null;
  private tracks = new Map<MusicTrack, GainNode>();
  private sfxLevel = 0.8;
  private musicLevel = 0.6;
  private wantMusic: MusicTrack | null = 'menu';
  /** The announcer line playing now (one at a time), and its importance. */
  private voice: { src: AudioBufferSourceNode; priority: number } | null = null;
  /** Announcer on/off (Settings). */
  announcer = true;
  private master: GainNode | null = null;
  private muted = false;

  constructor() {
    // Browsers only allow audio after the player interacts with the page.
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** Silences everything (a game portal's mute button, or while an ad plays). */
  setMuted(on: boolean): void {
    this.muted = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  /** @param sfx 0..10 @param music 0..10 */
  setVolumes(sfx: number, music: number): void {
    this.sfxLevel = sfx / 10;
    this.musicLevel = music / 10;
    if (!this.ctx) return;
    this.sfxGain.gain.value = this.sfxLevel;
    this.applyMusicLevel();
  }

  /** Which music plays: menu music, match music, or none (crossfades). */
  setMusic(track: MusicTrack | null): void {
    this.wantMusic = track;
    this.applyMusicLevel();
  }

  /**
   * The announcer says a line. Only one at a time: a more important line cuts in, anything else
   * waits its turn by being skipped. The music dips while he talks.
   */
  say(line: VoiceLine, priority = 1): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(`vo_${line}`)?.[0];
    if (!ctx || ctx.state !== 'running' || !buf || !this.announcer) return;
    if (this.voice) {
      if (this.voice.priority >= priority) return;
      this.voice.src.onended = null;
      this.voice.src.stop();
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 1.15;
    src.connect(g).connect(this.sfxGain);
    src.start();
    this.voice = { src, priority };
    this.applyMusicLevel();
    src.onended = () => {
      if (this.voice?.src !== src) return;
      this.voice = null;
      this.applyMusicLevel();
    };
  }

  play(name: SoundName, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const out = this.routeTo(opts.pan ?? 0, opts.volume ?? 1);
    const files = this.buffers.get(name);
    const file = files?.[Math.floor(Math.random() * files.length)];
    if (file) {
      const src = ctx.createBufferSource();
      src.buffer = file;
      src.playbackRate.value = opts.pitch ?? 1;
      src.connect(out);
      src.start();
      return;
    }
    this.synth(name, out, opts.pitch ?? 1);
  }

  // ---------------------------------------------------------------- setup

  private ensure(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxLevel;
    this.sfxGain.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.connect(this.master);
    this.noise = this.makeNoise(ctx);
    void this.loadFiles();
    this.applyMusicLevel();
  }

  private async loadFiles(): Promise<void> {
    const load = async (file: string): Promise<AudioBuffer | null> => {
      for (const ext of EXTENSIONS) {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}audio/${file}.${ext}`);
          // Dev servers answer missing files with the HTML page; only accept real audio.
          if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) continue;
          return await this.ctx!.decodeAudioData(await res.arrayBuffer());
        } catch {
          // try the next extension
        }
      }
      return null;
    };
    await Promise.all(
      FILE_SOUNDS.map(async (name) => {
        const single = await load(name);
        const list = single ? [single] : [];
        // Numbered variations: name_1, name_2, … until one is missing.
        for (let i = 1; !single && i <= 8; i++) {
          const b = await load(`${name}_${i}`);
          if (!b) break;
          list.push(b);
        }
        if (!list.length) return;
        this.buffers.set(name, list);
        if (name === 'music') this.startMusic('menu', list[0]);
        if (name === 'match') this.startMusic('match', list[0]);
      }),
    );
  }

  private applyMusicLevel(): void {
    if (!this.ctx) return;
    const duck = this.voice ? 0.45 : 1;
    for (const [name, g] of this.tracks) {
      const level = this.wantMusic === name ? LEVEL[name] * this.musicLevel * duck : 0;
      g.gain.setTargetAtTime(level, this.ctx.currentTime, this.voice ? 0.08 : 0.8);
    }
  }

  /** Both tracks loop from the start; switching only crossfades their volumes. */
  private startMusic(name: MusicTrack, buf: AudioBuffer): void {
    const ctx = this.ctx!;
    if (this.tracks.has(name)) return;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.musicGain);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (name === 'match' && buf.duration > MATCH_LOOP.end) {
      src.loopStart = MATCH_LOOP.start;
      src.loopEnd = MATCH_LOOP.end;
    }
    src.connect(g);
    src.start();
    this.tracks.set(name, g);
    this.applyMusicLevel();
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private routeTo(pan: number, volume: number): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = volume;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.sfxGain);
    return g;
  }

  // ---------------------------------------------------------------- synthesized fallbacks

  private synth(name: SoundName, out: AudioNode, pitch: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const env = (node: AudioNode, peak: number, attack: number, decay: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      node.connect(g).connect(out);
      return g;
    };
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number, peak: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0 * pitch, t);
      o.frequency.exponentialRampToValueAtTime(f1 * pitch, t + dur);
      env(o, peak, 0.003, dur);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    const noise = (type: BiquadFilterType, freq: number, q: number, dur: number, peak: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq * pitch;
      f.Q.value = q;
      src.connect(f);
      env(f, peak, 0.004, dur);
      src.start(t, Math.random());
      src.stop(t + dur + 0.05);
    };

    switch (name) {
      case 'paddle': // the hollow plastic "pop" of a pickleball off a paddle
        tone('triangle', 720, 380, 0.07, 0.9);
        noise('bandpass', 1900, 3, 0.05, 0.8);
        break;
      case 'bounce': // a dull thock on the court
        tone('sine', 230, 110, 0.09, 0.8);
        noise('lowpass', 900, 1, 0.04, 0.35);
        break;
      case 'net': // the net rustling
        noise('bandpass', 1100, 1.2, 0.22, 0.6);
        tone('sine', 140, 90, 0.12, 0.3);
        break;
      case 'click':
        tone('square', 900, 1300, 0.04, 0.25);
        break;
    }
  }
}
