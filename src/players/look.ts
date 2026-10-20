import type { HairStyle, Headwear, Palette } from './palette';

/**
 * One choice in the character creator. `unlock` items must be earned first: in the tournament
 * or career, or (with a `price`) bought with coins in the shop.
 */
export interface LookOption {
  name: string;
  color: string;
  unlock?: string;
  price?: number;
}

export const SKIN_TONES: LookOption[] = [
  { name: 'Light', color: '#ffdbac' },
  { name: 'Fair', color: '#f1c27d' },
  { name: 'Medium', color: '#e0ac69' },
  { name: 'Tan', color: '#c68642' },
  { name: 'Brown', color: '#8d5524' },
  { name: 'Deep', color: '#5c3a21' },
];
export const HAIR_COLORS: LookOption[] = [
  { name: 'Black', color: '#1b1530' },
  { name: 'Dark brown', color: '#3b2414' },
  { name: 'Brown', color: '#6b3e26' },
  { name: 'Auburn', color: '#a0522d' },
  { name: 'Blonde', color: '#d4a24c' },
  { name: 'Gray', color: '#9a9a9a' },
];
export const SHIRTS: LookOption[] = [
  { name: 'Orange', color: '#ff6b35' },
  { name: 'Red', color: '#e63946' },
  { name: 'Blue', color: '#3d7be0' },
  { name: 'Navy', color: '#2b2d62' },
  { name: 'Green', color: '#2a9d8f' },
  { name: 'Yellow', color: '#ffd23f' },
  { name: 'Pink', color: '#ff8fab' },
  { name: 'White', color: '#f5f5f5' },
  { name: 'Mint', color: '#7ee8c3', unlock: 'shirt-mint' },
  { name: 'Gold', color: '#ffc83d', unlock: 'shirt-gold' },
  { name: 'Purple', color: '#7b2ff7', unlock: 'buy-shirt-purple', price: 120 },
  { name: 'Black', color: '#26232e', unlock: 'buy-shirt-black', price: 120 },
  { name: 'Lime', color: '#a7e22e', unlock: 'buy-shirt-lime', price: 150 },
  { name: 'Coral', color: '#ff7f6e', unlock: 'buy-shirt-coral', price: 150 },
  { name: 'Royal Pro', color: '#1846c9', unlock: 'career-3' },
  { name: 'Zilla', color: '#46c35a', unlock: 'career-4' },
];
export const SHORTS: LookOption[] = [
  { name: 'Charcoal', color: '#2b2d42' },
  { name: 'Black', color: '#1b1530' },
  { name: 'Navy', color: '#22305a' },
  { name: 'Khaki', color: '#b8a07a' },
  { name: 'White', color: '#eeeeee' },
  { name: 'Red', color: '#b8322a', unlock: 'buy-shorts-red', price: 80 },
  { name: 'Royal', color: '#2d5bd8', unlock: 'buy-shorts-royal', price: 80 },
  { name: 'Teal', color: '#1f9e8f', unlock: 'career-1' },
];
export const CAP_COLORS: LookOption[] = [
  { name: 'Yellow', color: '#ffd23f' },
  { name: 'White', color: '#ffffff' },
  { name: 'Black', color: '#1b1530' },
  { name: 'Red', color: '#e63946' },
  { name: 'Teal', color: '#00b4d8' },
  { name: 'Purple', color: '#7b2ff7', unlock: 'cap-purple' },
  { name: 'Orange', color: '#ff8c1a', unlock: 'buy-cap-orange', price: 80 },
  { name: 'Pink', color: '#ff8fab', unlock: 'buy-cap-pink', price: 80 },
  { name: 'Sunset', color: '#ff5f45', unlock: 'career-2' },
];
export const PADDLES: LookOption[] = [
  { name: 'Red', color: '#e63946' },
  { name: 'Blue', color: '#3d7be0' },
  { name: 'Black', color: '#1b1530' },
  { name: 'White', color: '#f5f5f5' },
  { name: 'Sky', color: '#5cc4ff', unlock: 'paddle-sky' },
  { name: 'Flame', color: '#ff5a1f', unlock: 'paddle-flame' },
  { name: 'Gold', color: '#ffc83d', unlock: 'paddle-gold' },
  { name: 'Teal', color: '#00b4d8', unlock: 'buy-paddle-teal', price: 150 },
  { name: 'Pink', color: '#ff5fa2', unlock: 'buy-paddle-pink', price: 150 },
  { name: 'Purple', color: '#8a2be2', unlock: 'buy-paddle-purple', price: 200 },
  { name: 'Neon', color: '#39ff14', unlock: 'buy-paddle-neon', price: 250 },
  { name: 'Zilla', color: '#2bd94a', unlock: 'career-4' },
];
export const HAIR_STYLES: { name: string; id: HairStyle }[] = [
  { name: 'Short', id: 'short' },
  { name: 'Ponytail', id: 'ponytail' },
  { name: 'Shaved', id: 'shaved' },
];
export const HEADWEAR: { name: string; id: Headwear; unlock?: string }[] = [
  { name: 'Cap', id: 'cap' },
  { name: 'Headband', id: 'headband' },
  { name: 'None', id: 'none' },
  { name: 'Crown', id: 'crown', unlock: 'crown' },
];

/** Your player's look, stored as indexes into the lists above. */
export interface Look {
  skin: number;
  hairStyle: number;
  hair: number;
  shirt: number;
  shorts: number;
  headwear: number;
  cap: number;
  paddle: number;
}

export const DEFAULT_LOOK: Look = { skin: 1, hairStyle: 0, hair: 1, shirt: 0, shorts: 0, headwear: 0, cap: 0, paddle: 0 };

const at = <T>(list: T[], i: number) => list[Math.max(0, Math.min(list.length - 1, i))];

/** The palette the 3D model uses for a look. */
export function lookToPalette(look: Look): Palette {
  const headwear = at(HEADWEAR, look.headwear).id;
  return {
    skin: at(SKIN_TONES, look.skin).color,
    hair: at(HAIR_COLORS, look.hair).color,
    iris: '#3d6fb5',
    shirt: at(SHIRTS, look.shirt).color,
    trim: '#ffffff',
    shorts: at(SHORTS, look.shorts).color,
    hairStyle: at(HAIR_STYLES, look.hairStyle).id,
    headwear,
    cap: at(CAP_COLORS, look.cap).color,
    headband: at(CAP_COLORS, look.cap).color,
    shoe: '#f5f5f5',
    sole: at(SHIRTS, look.shirt).color,
    sock: '#ffffff',
    paddle: at(PADDLES, look.paddle).color,
    paddle_edge: '#1b1530',
    grip: '#1b1530',
  };
}

/** Indexes (into `list`) of the options this player can pick. */
export function available<T extends { unlock?: string }>(list: T[], unlocked: string[]): number[] {
  return list.map((o, i) => (!o.unlock || unlocked.includes(o.unlock) ? i : -1)).filter((i) => i >= 0);
}
