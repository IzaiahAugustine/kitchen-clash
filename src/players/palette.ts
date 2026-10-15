/** Colors for each material slot of the player model, plus what they wear on their head. */
export interface Palette {
  skin: string;
  hair: string;
  iris: string;
  shirt: string;
  /** Collar, sleeve hems and waistband. */
  trim: string;
  shorts: string;
  headwear: 'cap' | 'headband' | 'none';
  cap: string;
  headband: string;
  shoe: string;
  sole: string;
  sock: string;
  paddle: string;
  paddle_edge: string;
  grip: string;
}

export const PALETTES = {
  hero: {
    skin: '#e8b98a',
    hair: '#4a2f1b',
    iris: '#3d6fb5',
    shirt: '#ff6b35',
    trim: '#ffffff',
    shorts: '#2b2d42',
    headwear: 'cap',
    cap: '#ffd23f',
    headband: '#ffffff',
    shoe: '#f5f5f5',
    sole: '#ff6b35',
    sock: '#ffffff',
    paddle: '#e63946',
    paddle_edge: '#1b1530',
    grip: '#1b1530',
  },
  rival: {
    skin: '#8d5524',
    hair: '#141014',
    iris: '#3b2414',
    shirt: '#7b2ff7',
    trim: '#00d1b2',
    shorts: '#1b1530',
    headwear: 'headband',
    cap: '#00d1b2',
    headband: '#00d1b2',
    shoe: '#ffd23f',
    sole: '#1b1530',
    sock: '#ffffff',
    paddle: '#00b4d8',
    paddle_edge: '#1b1530',
    grip: '#1b1530',
  },
  partner: {
    skin: '#c68642',
    hair: '#1b1530',
    iris: '#3b2414',
    shirt: '#2ec4b6',
    trim: '#ffffff',
    shorts: '#2b2d42',
    headwear: 'cap',
    cap: '#ff6b35',
    headband: '#ffffff',
    shoe: '#f5f5f5',
    sole: '#2ec4b6',
    sock: '#ffffff',
    paddle: '#ffd23f',
    paddle_edge: '#1b1530',
    grip: '#1b1530',
  },
  rival2: {
    skin: '#ffdbac',
    hair: '#d4a24c',
    iris: '#3d6fb5',
    shirt: '#e63946',
    trim: '#1b1530',
    shorts: '#1b1530',
    headwear: 'cap',
    cap: '#1b1530',
    headband: '#e63946',
    shoe: '#f5f5f5',
    sole: '#e63946',
    sock: '#ffffff',
    paddle: '#ffffff',
    paddle_edge: '#e63946',
    grip: '#1b1530',
  },
} satisfies Record<string, Palette>;
