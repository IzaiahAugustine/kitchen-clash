import { PROFILES, type AiProfile, type Difficulty } from '../ai/difficulty';
import type { Palette } from '../players/palette';
import type { VenueId } from '../render/venues';

/** A tournament opponent: a named player with a style, a court, a tip, and a prize. */
export interface Rival {
  name: string;
  /** Short description of how they play. */
  style: string;
  /** Advice for beating them. */
  tip: string;
  profile: AiProfile;
  palette: Palette;
  venue: VenueId;
  /** Points to win the game. */
  target: number;
  reward: { id: string; label: string };
}

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

/** The road to the Pickle Crown: six rivals, each tougher than the last. */
export const RIVALS: Rival[] = [
  {
    name: 'Dinky Dan',
    style: 'Loves to dink. Rarely attacks.',
    tip: 'Be patient at the kitchen and wait for a high ball to power.',
    profile: style('easy', { label: 'Dinky Dan', attack: 0.1, lobRate: 0.02, dropRate: 0.95 }),
    palette: look({ shirt: '#90be6d', skin: '#ffdbac', hair: '#d4a24c', headwear: 'cap', cap: '#2a9d8f' }),
    venue: 'park',
    target: 7,
    reward: { id: 'shirt-mint', label: 'Mint shirt' },
  },
  {
    name: "Lobbin' Lucy",
    style: 'Lobs over you every chance she gets.',
    tip: "Don't crowd the net: stay a step behind the kitchen line so you can chase lobs.",
    profile: style('easy', { label: "Lobbin' Lucy", lobRate: 0.45, reach: 1.6, timingNoise: 0.088 }),
    palette: look({ shirt: '#ff8fab', skin: '#c68642', hair: '#1b1530', hairStyle: 'ponytail', headwear: 'headband', headband: '#ffffff' }),
    venue: 'beach',
    target: 7,
    reward: { id: 'paddle-sky', label: 'Sky paddle' },
  },
  {
    name: 'Banger Bo',
    style: 'Drives everything as hard as he can.',
    tip: 'Block his drives softly (J at the kitchen) and let him make the mistakes.',
    profile: style('medium', { label: 'Banger Bo', dropRate: 0.25, attack: 0.85, blunder: 0.085 }),
    palette: look({ shirt: '#e63946', skin: '#8d5524', hair: '#1b1530', hairStyle: 'shaved', headwear: 'none', paddle: '#1b1530' }),
    venue: 'gym',
    target: 7,
    reward: { id: 'paddle-flame', label: 'Flame paddle' },
  },
  {
    name: 'Kitchen Kim',
    style: 'Lives at the kitchen line. Dink master.',
    tip: 'Keep your dinks low so she can never attack, and pounce on a high one.',
    profile: style('medium', { label: 'Kitchen Kim', lazyFeet: 0, shotIQ: 0.75, attack: 0.55, lobRate: 0.06 }),
    palette: look({ shirt: '#2a9d8f', skin: '#f1c27d', hair: '#1b1530', hairStyle: 'ponytail', headwear: 'cap', cap: '#ffffff' }),
    venue: 'park',
    target: 9,
    reward: { id: 'cap-purple', label: 'Purple cap' },
  },
  {
    name: 'Rally Ray',
    style: 'Gets everything back. Very few mistakes.',
    tip: 'Rallies will be long. Move him side to side and wait for the opening.',
    profile: style('hard', { label: 'Rally Ray', blunder: 0.04, attack: 0.3, reach: 2.1 }),
    palette: look({ shirt: '#3d5a80', skin: '#5c3a21', hair: '#2b1b10', headwear: 'headband', headband: '#ffd23f', paddle: '#ffffff' }),
    venue: 'beach',
    target: 9,
    reward: { id: 'shirt-gold', label: 'Gold shirt' },
  },
  {
    name: 'The Pickle Champ',
    style: 'The reigning champion. Does everything well.',
    tip: 'Mix it up: drop, dink, then strike with Power when the ball sits up.',
    profile: style('hard', { label: 'Champ', timingNoise: 0.072, blunder: 0.05, shotIQ: 0.88 }),
    palette: look({ shirt: '#1b1530', trim: '#ffc83d', skin: '#e0ac69', hair: '#1b1530', headwear: 'crown', paddle: '#ffc83d' }),
    venue: 'night',
    target: 11,
    reward: { id: 'crown', label: 'Crown + Gold paddle' },
  },
];

/** Everything a tournament win unlocks (the final also unlocks the gold paddle). */
export function rewardsFor(round: number): string[] {
  const r = RIVALS[round].reward.id;
  return r === 'crown' ? ['crown', 'paddle-gold'] : [r];
}
