/** Colors for each material slot of the player model. */
export interface Palette {
  skin: string;
  shirt: string;
  shorts: string;
  cap: string;
  shoe: string;
  sock: string;
  paddle: string;
  grip: string;
}

export const PALETTES = {
  hero: {
    skin: '#f1c27d',
    shirt: '#ff6b35',
    shorts: '#2b2d42',
    cap: '#ffd23f',
    shoe: '#f5f5f5',
    sock: '#ffffff',
    paddle: '#e63946',
    grip: '#1b1530',
  },
  rival: {
    skin: '#8d5524',
    shirt: '#7b2ff7',
    shorts: '#1b1530',
    cap: '#00d1b2',
    shoe: '#ffd23f',
    sock: '#ffffff',
    paddle: '#00b4d8',
    grip: '#1b1530',
  },
} satisfies Record<string, Palette>;
