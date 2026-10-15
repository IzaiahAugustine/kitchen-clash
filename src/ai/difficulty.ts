export type Difficulty = 'easy' | 'medium' | 'hard';

/** Everything that makes one AI level play differently from another. */
export interface AiProfile {
  label: string;
  /** Seconds before reacting to the opponent's shot. */
  reaction: number;
  /** Fraction of full foot speed. */
  speed: number;
  /** Typical button-timing error (s): bigger = more Early/Late shots. */
  timingNoise: number;
  /** Chance per shot of a badly mistimed swing (an unforced error). */
  blunder: number;
  /** Chance of picking the right shot for the situation. */
  shotIQ: number;
  /** How close to the sidelines it dares to aim (0..1). */
  angle: number;
  /** Chance per rally of hanging back instead of moving up to the kitchen. */
  lazyFeet: number;
  /** Chance of forgetting the kitchen / two-bounce rule on a shot. */
  ruleSlip: number;
  /** Chance a serve is a risky, deep hard one. */
  serveRisk: number;
  /** How far (ft) it's willing to lunge for a ball when planning (the most anyone can is 2.2). */
  reach: number;
}

export const PROFILES: Record<Difficulty, AiProfile> = {
  easy: {
    label: 'Easy',
    reaction: 0.28,
    speed: 0.88,
    timingNoise: 0.095,
    blunder: 0.09,
    shotIQ: 0.45,
    angle: 0.4,
    lazyFeet: 0.4,
    ruleSlip: 0.03,
    serveRisk: 0.12,
    reach: 1.5,
  },
  medium: {
    label: 'Medium',
    reaction: 0.21,
    speed: 0.92,
    timingNoise: 0.082,
    blunder: 0.07,
    shotIQ: 0.65,
    angle: 0.55,
    lazyFeet: 0.15,
    ruleSlip: 0.01,
    serveRisk: 0.07,
    reach: 1.8,
  },
  hard: {
    label: 'Hard',
    reaction: 0.18,
    speed: 0.95,
    timingNoise: 0.079,
    blunder: 0.06,
    shotIQ: 0.8,
    angle: 0.65,
    lazyFeet: 0,
    ruleSlip: 0,
    serveRisk: 0.04,
    reach: 1.9,
  },
};

export function parseDifficulty(s: string | null | undefined, fallback: Difficulty = 'medium'): Difficulty {
  return s === 'easy' || s === 'medium' || s === 'hard' ? s : fallback;
}
