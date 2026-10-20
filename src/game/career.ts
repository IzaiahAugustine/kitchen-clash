import { PROFILES, type AiProfile, type Difficulty } from '../ai/difficulty';
import type { Palette } from '../players/palette';
import type { VenueId } from '../render/venues';

/**
 * Career: climb four leagues (16 opponents) to face Dinkzilla. Every match earns XP; each
 * level gives a point to spend on your player's Speed, Power, Touch or Reach, which change
 * how you play (see `boosts`).
 */

export type StatId = 'speed' | 'power' | 'touch' | 'reach';
export type CareerStats = Record<StatId, number>;

export interface CareerState {
  /** Index of the next opponent to beat (CAREER.length = finished). */
  match: number;
  xp: number;
  level: number;
  /** Upgrade points not spent yet. */
  points: number;
  stats: CareerStats;
}

export const NEW_CAREER: CareerState = { match: 0, xp: 0, level: 1, points: 0, stats: { speed: 0, power: 0, touch: 0, reach: 0 } };

export const MAX_STAT = 5;

export const STATS: { id: StatId; name: string; text: string }[] = [
  { id: 'speed', name: 'Speed', text: 'Faster around the court' },
  { id: 'power', name: 'Power', text: 'Harder drives, smashes and rolls' },
  { id: 'touch', name: 'Touch', text: 'Wider timing window for Perfect hits' },
  { id: 'reach', name: 'Reach', text: 'Lunge farther for wide balls' },
];

/** What each stat level does to your player (1 = no change). */
export function boosts(s: CareerStats): { speed: number; power: number; touch: number; reach: number } {
  return {
    speed: 1 + 0.03 * s.speed,
    power: 1 + 0.04 * s.power,
    touch: 1 + 0.08 * s.touch,
    reach: 1 + 0.06 * s.reach,
  };
}

/** XP needed to go from `level` to the next. */
export function xpToNext(level: number): number {
  return 100 + (level - 1) * 40;
}

/** XP for a career match: something for playing, more for winning, a bonus for bosses. */
export function xpForMatch(won: boolean, points: number, perfects: number, boss: boolean): number {
  const base = (won ? 60 : 20) + points * 3 + Math.min(15, perfects);
  return Math.round(base * (boss ? 1.5 : 1));
}

/** Add XP; returns how many levels were gained (each gives one upgrade point). */
export function addXp(c: CareerState, xp: number): number {
  let gained = 0;
  c.xp += xp;
  while (c.xp >= xpToNext(c.level)) {
    c.xp -= xpToNext(c.level);
    c.level++;
    c.points++;
    gained++;
  }
  return gained;
}

/** Spend a point on a stat (if there's one to spend and room to grow). */
export function upgrade(c: CareerState, id: StatId): boolean {
  if (c.points <= 0 || c.stats[id] >= MAX_STAT) return false;
  c.points--;
  c.stats[id]++;
  return true;
}

export interface CareerOpponent {
  name: string;
  style: string;
  tip: string;
  profile: AiProfile;
  palette: Palette;
  venue: VenueId;
  target: number;
  league: number;
  /** Last opponent of a league: beating them unlocks `reward`. */
  boss?: boolean;
  reward?: { ids: string[]; label: string };
  /** Drawn this much bigger (Dinkzilla). */
  scale?: number;
  /** Their own Reach/Power edge (Dinkzilla). */
  edge?: { reach: number; power: number };
}

export const LEAGUES = [
  { name: 'Rookie League', venue: 'park' as VenueId },
  { name: 'Club League', venue: 'beach' as VenueId },
  { name: 'Pro Tour', venue: 'gym' as VenueId },
  { name: 'Legends', venue: 'night' as VenueId },
];

const look = (p: Partial<Palette>): Palette => ({
  skin: '#e0ac69',
  hair: '#3b2414',
  iris: '#3b2414',
  shirt: '#7b2ff7',
  trim: '#ffffff',
  shorts: '#1b1530',
  hairStyle: 'short',
  headwear: 'none',
  cap: '#1b1530',
  headband: '#ffffff',
  shoe: '#f5f5f5',
  sole: '#1b1530',
  sock: '#ffffff',
  paddle: '#00b4d8',
  paddle_edge: '#1b1530',
  grip: '#1b1530',
  ...p,
});

const style = (base: Difficulty, s: Partial<AiProfile>): AiProfile => ({ ...PROFILES[base], ...s });
/** Tougher than Hard: the last league. */
const legend = (s: Partial<AiProfile>): AiProfile =>
  style('hard', { reaction: 0.16, speed: 0.98, timingNoise: 0.07, blunder: 0.045, shotIQ: 0.88, angle: 0.72, reach: 2.0, ...s });

type Entry = Omit<CareerOpponent, 'league' | 'venue' | 'target'>;

const league = (i: number, target: number, list: Entry[]): CareerOpponent[] =>
  list.map((o) => ({ ...o, league: i, venue: LEAGUES[i].venue, target }));

export const CAREER: CareerOpponent[] = [
  ...league(0, 7, [
    {
      name: 'Weekend Walt',
      style: 'Plays on Saturdays. Slow feet, lots of mistakes.',
      tip: 'Keep the ball in play: he will miss before you do.',
      profile: style('easy', { label: 'Walt', speed: 0.8, blunder: 0.12, reaction: 0.32 }),
      palette: look({ shirt: '#9fb8c9', skin: '#f1c27d', hair: '#9a9a9a', headwear: 'cap', cap: '#22305a' }),
    },
    {
      name: 'Sunny Sam',
      style: 'Loves a high, lazy lob.',
      tip: 'Stay a step back from the kitchen so lobs land in front of you.',
      profile: style('easy', { label: 'Sam', lobRate: 0.35 }),
      palette: look({ shirt: '#ffd23f', skin: '#c68642', hair: '#1b1530', headwear: 'headband', headband: '#ff6b35' }),
    },
    {
      name: 'Dinky Dot',
      style: 'Dinks all day and never hits hard.',
      tip: 'Wait for a high dink and put it away.',
      profile: style('easy', { label: 'Dot', attack: 0.08, dropRate: 0.95 }),
      palette: look({ shirt: '#ff8fab', skin: '#ffdbac', hair: '#a0522d', hairStyle: 'ponytail' }),
    },
    {
      name: 'Coach Carla',
      style: 'Rookie League boss. Solid at everything.',
      tip: 'She punishes high balls: keep your dinks low.',
      profile: style('medium', { label: 'Carla', blunder: 0.075 }),
      palette: look({ shirt: '#2a9d8f', skin: '#8d5524', hair: '#1b1530', hairStyle: 'ponytail', headwear: 'cap', cap: '#ffffff' }),
      boss: true,
      reward: { ids: ['career-1'], label: 'Teal shorts' },
    },
  ]),
  ...league(1, 9, [
    {
      name: 'Breezy Ben',
      style: 'Floats lobs into the sea breeze.',
      tip: 'Back up a step whenever he is at the kitchen.',
      profile: style('medium', { label: 'Ben', lobRate: 0.4 }),
      palette: look({ shirt: '#5cc4ff', skin: '#e0ac69', hair: '#d4a24c', headwear: 'cap', cap: '#ffd23f' }),
    },
    {
      name: "Slammin' Sal",
      style: 'Drives every ball as hard as she can.',
      tip: 'Block her drives softly and let her make the errors.',
      profile: style('medium', { label: 'Sal', attack: 0.85, dropRate: 0.2, blunder: 0.08 }),
      palette: look({ shirt: '#e63946', skin: '#f1c27d', hair: '#1b1530', hairStyle: 'ponytail', headwear: 'headband' }),
    },
    {
      name: 'Net Ninja Nia',
      style: 'Rushes the net and volleys everything.',
      tip: 'Lob over her when she crowds the kitchen.',
      profile: style('medium', { label: 'Nia', lazyFeet: 0, reaction: 0.17, attack: 0.6 }),
      palette: look({ shirt: '#1b1530', trim: '#ff3d7f', skin: '#c68642', hair: '#1b1530', paddle: '#ff3d7f' }),
    },
    {
      name: 'Big Mike',
      style: 'Club League boss. Huge serve, huge drives.',
      tip: 'Return deep, then get to the kitchen before he can attack.',
      profile: style('hard', { label: 'Mike', serveRisk: 0.25, attack: 0.75, blunder: 0.065 }),
      palette: look({ shirt: '#ff8c1a', skin: '#5c3a21', hair: '#1b1530', hairStyle: 'shaved', paddle: '#1b1530' }),
      boss: true,
      reward: { ids: ['career-2'], label: 'Sunset cap' },
    },
  ]),
  ...league(2, 11, [
    {
      name: 'Rocket Rosa',
      style: 'The fastest feet on tour.',
      tip: 'Angles will not beat her: wait for a high ball.',
      profile: style('hard', { label: 'Rosa', speed: 1.0, reaction: 0.16 }),
      palette: look({ shirt: '#ff5f45', skin: '#e0ac69', hair: '#6b3e26', hairStyle: 'ponytail', headwear: 'cap', cap: '#1b1530' }),
    },
    {
      name: 'The Wall',
      style: 'Gets everything back. Almost never misses.',
      tip: 'Long rallies: move him side to side and be patient.',
      profile: style('hard', { label: 'Wall', blunder: 0.035, attack: 0.3, reach: 2.1 }),
      palette: look({ shirt: '#6c757d', skin: '#ffdbac', hair: '#3b2414', headwear: 'headband', headband: '#1b1530' }),
    },
    {
      name: 'Spin Doctor Sid',
      style: 'Rolls and slices with nasty spin.',
      tip: 'Expect dipping balls: get low and time it late.',
      profile: style('hard', { label: 'Sid', shotIQ: 0.85, angle: 0.75 }),
      palette: look({ shirt: '#7b2ff7', skin: '#8d5524', hair: '#1b1530', headwear: 'cap', cap: '#7b2ff7', paddle: '#ffffff' }),
    },
    {
      name: 'Ace Alvarez',
      style: 'Pro Tour boss. Serves bullets.',
      tip: 'Stand deep for his serve, then take the net.',
      profile: legend({ label: 'Alvarez', serveRisk: 0.3 }),
      palette: look({ shirt: '#1846c9', trim: '#ffd23f', skin: '#c68642', hair: '#1b1530', headwear: 'headband', headband: '#ffd23f' }),
      boss: true,
      reward: { ids: ['career-3'], label: 'Royal Pro shirt' },
    },
  ]),
  ...league(3, 11, [
    {
      name: 'Silver Fox',
      style: 'Thirty years of tricks.',
      tip: 'He reads your patterns: mix drops and drives.',
      profile: legend({ label: 'Fox', speed: 0.92, shotIQ: 0.92 }),
      palette: look({ shirt: '#f5f5f5', skin: '#f1c27d', hair: '#d9d9d9', headwear: 'cap', cap: '#22305a', paddle: '#1b1530' }),
    },
    {
      name: 'Lightning Lee',
      style: 'Hits the fastest drives in the game.',
      tip: 'Block soft at the kitchen; do not trade drives.',
      profile: legend({ label: 'Lee', attack: 0.85 }),
      palette: look({ shirt: '#ffd23f', trim: '#1b1530', skin: '#e0ac69', hair: '#1b1530', paddle: '#ffd23f' }),
    },
    {
      name: 'Queen of the Kitchen',
      style: 'The best dinker alive.',
      tip: 'Keep every dink low. One high ball and she ends it.',
      profile: legend({ label: 'Queen', dropRate: 0.9, lazyFeet: 0 }),
      palette: look({ shirt: '#ff3d7f', trim: '#ffc83d', skin: '#5c3a21', hair: '#1b1530', hairStyle: 'ponytail', headwear: 'crown' }),
    },
    {
      name: 'DINKZILLA',
      style: 'The final boss. Enormous, fast, and very angry.',
      tip: 'Huge reach: aim at his feet and wait for a ball to smash.',
      profile: legend({ label: 'Dinkzilla', reaction: 0.15, blunder: 0.04, attack: 0.7 }),
      palette: look({ shirt: '#2e7d32', trim: '#a7e22e', skin: '#5fae3a', hair: '#1f5e1f', iris: '#e63946', shorts: '#1b1530', paddle: '#a7e22e', hairStyle: 'shaved', headwear: 'none', spikes: '#a7e22e' }),
      boss: true,
      scale: 1.22,
      edge: { reach: 1.18, power: 1.06 },
      reward: { ids: ['career-4'], label: 'Zilla shirt + Zilla paddle' },
    },
  ]),
];
