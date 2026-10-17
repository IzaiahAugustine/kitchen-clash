import type { Difficulty } from '../ai/difficulty';
import { DEFAULT_LOOK, type Look } from '../players/look';
import type { VenueId } from '../render/venues';
import type { ScoringMode } from '../rules/scoring';
import { NEW_PROGRESS, type ProgressState } from './progress';

export type CameraPreset = 'close' | 'classic' | 'wide';

export interface Settings {
  difficulty: Difficulty;
  /** Singles (1v1) or doubles (2v2, you + an AI partner). */
  format: 'singles' | 'doubles';
  /** Watch mode: near and far AI levels. */
  watchNear: Difficulty;
  watchFar: Difficulty;
  scoring: ScoringMode;
  camera: CameraPreset;
  /** 0..10 */
  sfxVolume: number;
  musicVolume: number;
  /** High adds ambient occlusion (needs a strong GPU). */
  graphics: 'standard' | 'high';
  /** Finished (or skipped through) How to Play. */
  tutorialDone: boolean;
  /** Your name in online matches. */
  name: string;
  /** Your player's look (My Player). */
  look: Look;
  /** Gear earned in the tournament. */
  unlocked: string[];
  /** Tournament rivals beaten so far (0..6). */
  tourneyWins: number;
  /** Court for Play vs AI. */
  court: VenueId;
  /** Seconds played in total (new players get the control hints for a while). */
  playSeconds: number;
  /** Coins, challenges, achievements. */
  progress: ProgressState;
}

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'medium',
  format: 'singles',
  watchNear: 'medium',
  watchFar: 'hard',
  scoring: 'sideout',
  camera: 'close',
  sfxVolume: 8,
  musicVolume: 6,
  graphics: 'standard',
  tutorialDone: false,
  name: '',
  look: DEFAULT_LOOK,
  unlocked: [],
  tourneyWins: 0,
  court: 'park',
  playSeconds: 0,
  progress: NEW_PROGRESS,
};

/** A fresh copy (the defaults' nested objects must never be shared or changed). */
function fresh(saved: Partial<Settings> = {}): Settings {
  const p = saved.progress;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    unlocked: [...(saved.unlocked ?? [])],
    progress: {
      ...NEW_PROGRESS,
      ...p,
      stats: { ...NEW_PROGRESS.stats, ...p?.stats },
      achievements: [...(p?.achievements ?? [])],
      daily: p?.daily ? { ...p.daily, progress: [...p.daily.progress], done: [...p.daily.done] } : { ...NEW_PROGRESS.daily, progress: [0, 0, 0], done: [false, false, false] },
    },
  };
}

const KEY = 'kitchen-clash-settings';

/** Settings saved in this browser. Storage can be unavailable (private mode), so failures fall back to defaults. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return fresh(raw ? (JSON.parse(raw) as Partial<Settings>) : {});
  } catch {
    return fresh();
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not fatal: settings just won't persist
  }
}
