/**
 * Sound effects and music with the Web Audio API.
 *
 * Each sound first tries files in public/audio: <name>_1, <name>_2… (variations, one picked at
 * random each time) or plain <name>, as .mp3/.wav/.m4a/.ogg/.aac. Without a file it falls back
 * to a synthesized version so the game is never silent.
 * Music only plays from a file (public/audio/music.*).
 */

export type SoundName = 'paddle' | 'bounce' | 'net' | 'cheer' | 'click';
const FILE_SOUNDS: (SoundName | 'crowd' | 'music')[] = ['paddle', 'bounce', 'net', 'cheer', 'click', 'crowd', 'music'];
const EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', 'aac'];

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
  private ambienceGain!: GainNode;
  private buffers = new Map<string, AudioBuffer[]>();
  private applause: AudioBuffer | null = null;
  private noise: AudioBuffer | null = null;
  private music: AudioBufferSourceNode | null = null;
  private ambience: AudioBufferSourceNode | null = null;
  private sfxLevel = 0.8;
  private musicLevel = 0.6;
  private wantMusic = true;
  private wantAmbience = false;
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

  /** Menu music on/off (fades). */
  setMusic(on: boolean): void {
    this.wantMusic = on;
    this.applyMusicLevel();
  }

  /** Background crowd murmur on/off (fades). */
  setAmbience(on: boolean): void {
    this.wantAmbience = on;
    if (!this.ctx) return;
    this.ambienceGain.gain.setTargetAtTime(on ? 0.18 * this.sfxLevel : 0, this.ctx.currentTime, 0.6);
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
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.master);
    this.ambienceGain = ctx.createGain();
    this.ambienceGain.gain.value = 0;
    this.ambienceGain.connect(this.sfxGain);
    this.noise = this.makeNoise(ctx);
    this.applause = this.makeApplause(ctx);
    void this.loadFiles();
    this.startSynthAmbience();
    this.applyMusicLevel();
    this.setAmbience(this.wantAmbience);
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
        if (name === 'music') this.startMusic();
        if (name === 'crowd') this.startFileAmbience(list[0]);
      }),
    );
  }

  private applyMusicLevel(): void {
    if (!this.ctx) return;
    this.musicGain.gain.setTargetAtTime(this.wantMusic ? 0.55 * this.musicLevel : 0, this.ctx.currentTime, 0.8);
  }

  private startMusic(): void {
    const ctx = this.ctx!;
    const buf = this.buffers.get('music')?.[0];
    if (!buf || this.music) return;
    this.music = ctx.createBufferSource();
    this.music.buffer = buf;
    this.music.loop = true;
    this.music.connect(this.musicGain);
    this.music.start();
  }

  private startFileAmbience(buf: AudioBuffer): void {
    const ctx = this.ctx!;
    this.ambience?.stop();
    this.ambience = ctx.createBufferSource();
    this.ambience.buffer = buf;
    this.ambience.loop = true;
    this.ambience.connect(this.ambienceGain);
    this.ambience.start();
  }

  /** Soft crowd murmur from filtered noise, until a crowd recording is provided. */
  private startSynthAmbience(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 500;
    band.Q.value = 0.6;
    const level = ctx.createGain();
    level.gain.value = 0.35;
    src.connect(band).connect(level).connect(this.ambienceGain);
    src.start();
    this.ambience = src;
  }

  /**
   * Applause built from hundreds of single claps (each a tiny burst of filtered noise at its own
   * pitch), swelling in and tapering off — much more like a real crowd than one noise swell.
   */
  private makeApplause(ctx: AudioContext): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * 2.6);
    const buf = ctx.createBuffer(2, len, rate);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let k = 0; k < 520; k++) {
      // Most claps land in the first second; a few stragglers after.
      const at = Math.floor(Math.pow(Math.random(), 1.6) * 2.3 * rate);
      const dur = Math.floor((0.004 + Math.random() * 0.01) * rate);
      const swell = Math.min(1, at / (0.18 * rate)) * (1 - (at / len) * 0.75);
      const amp = (0.25 + Math.random() * 0.75) * swell * 0.16;
      const pan = Math.random();
      // A clap is a click resonating in cupped hands: noise through a quick resonant filter.
      const f = (900 + Math.random() * 1800) / rate;
      const r = 0.93;
      const c1 = 2 * r * Math.cos(2 * Math.PI * f);
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < dur * 3 && at + i < len; i++) {
        const x = i < dur ? (Math.random() * 2 - 1) * (1 - i / dur) : 0;
        const y = x + c1 * y1 - r * r * y2;
        y2 = y1;
        y1 = y;
        L[at + i] += y * amp * (1 - pan) * 0.5;
        R[at + i] += y * amp * pan * 0.5;
      }
    }
    return buf;
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
      case 'cheer': {
        // applause, over a soft swell of voices
        if (this.applause) {
          const a = ctx.createBufferSource();
          a.buffer = this.applause;
          a.playbackRate.value = 0.95 + Math.random() * 0.1;
          a.connect(out);
          a.start(t);
        }
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 650;
        f.Q.value = 0.8;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.3);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
        src.connect(f).connect(g).connect(out);
        src.start(t);
        src.stop(t + 2.1);
        break;
      }
    }
  }
}
