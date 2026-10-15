import type { Difficulty } from '../ai/difficulty';
import type { ScoringMode } from '../rules/scoring';

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
};

const KEY = 'kitchen-clash-settings';

/** Settings saved in this browser. Storage can be unavailable (private mode), so failures fall back to defaults. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not fatal: settings just won't persist
  }
}
