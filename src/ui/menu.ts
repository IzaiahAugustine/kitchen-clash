import type { Keyboard } from '../input/keyboard';

/** A menu row: a button, or a setting you change with left/right. */
export type MenuItem =
  | { label: string; action: () => void; primary?: boolean }
  | { label: string; options: string[]; get: () => number; set: (i: number) => void };

export interface MenuScreen {
  /** HTML above the items (logo, headline, results...). */
  header: string;
  items: MenuItem[];
  /** Escape / Backspace. */
  back?: () => void;
  /** Extra CSS class on the layer (e.g. 'title' for the full-screen title look). */
  variant?: string;
}

const UP = ['ArrowUp', 'KeyW'];
const DOWN = ['ArrowDown', 'KeyS'];
const LEFT = ['ArrowLeft', 'KeyA'];
const RIGHT = ['ArrowRight', 'KeyD'];
const OK = ['Enter', 'Space', 'KeyJ', 'KeyZ'];
const BACK = ['Escape', 'Backspace', 'KeyK', 'KeyX'];

/** Full-screen menus drawn in HTML over the 3D scene. Keyboard and mouse both work. */
export class Menu {
  private layer: HTMLDivElement;
  private screen: MenuScreen | null = null;
  private index = 0;
  /** Called on every navigation / activation (for the click sound). */
  onNavigate: () => void = () => {};
  /** Phones: show tap hints instead of keyboard hints. */
  touch = false;

  constructor(root: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'menu-layer';
    this.layer.style.display = 'none';
    root.appendChild(this.layer);
  }

  get open(): boolean {
    return this.screen !== null;
  }

  show(screen: MenuScreen): void {
    this.screen = screen;
    this.index = screen.items.findIndex((i) => 'action' in i && i.primary);
    if (this.index < 0) this.index = 0;
    this.render();
  }

  hide(): void {
    this.screen = null;
    this.layer.style.display = 'none';
  }

  /** Call once per frame while a menu is open. */
  handleKeys(keys: Keyboard): void {
    const s = this.screen;
    if (!s) return;
    // Typing in a text box (name, match code): leave the keys to it.
    if (document.activeElement instanceof HTMLInputElement) return;
    const pressed = (codes: string[]) => codes.some((c) => keys.wasPressed(c));
    const n = s.items.length;
    if (pressed(UP)) this.move((this.index - 1 + n) % n);
    else if (pressed(DOWN)) this.move((this.index + 1) % n);
    else if (pressed(LEFT)) this.cycle(-1);
    else if (pressed(RIGHT)) this.cycle(1);
    else if (pressed(OK)) this.activate(this.index);
    else if (pressed(BACK) && s.back) {
      this.onNavigate();
      s.back();
    }
  }

  private move(i: number): void {
    this.index = i;
    this.onNavigate();
    this.render();
  }

  private cycle(dir: number): void {
    const item = this.screen?.items[this.index];
    if (!item || !('options' in item)) return;
    const n = item.options.length;
    item.set((item.get() + dir + n) % n);
    this.onNavigate();
    this.render();
  }

  private activate(i: number): void {
    const item = this.screen?.items[i];
    if (!item) return;
    this.index = i;
    if ('action' in item) {
      this.onNavigate();
      item.action();
    } else {
      this.cycle(1);
    }
  }

  private render(): void {
    const s = this.screen;
    if (!s) return;
    this.layer.className = `menu-layer ${s.variant ?? ''}`;
    this.layer.style.display = 'grid';
    const rows = s.items
      .map((item, i) => {
        const sel = i === this.index ? ' selected' : '';
        if ('action' in item) {
          return `<button class="menu-item${item.primary ? ' primary' : ''}${sel}" data-i="${i}">${item.label}</button>`;
        }
        return `<button class="menu-item option${sel}" data-i="${i}">
          <span class="opt-label">${item.label}</span>
          <span class="opt-value"><span class="arrow" data-dir="-1">‹</span>${item.options[item.get()]}<span class="arrow" data-dir="1">›</span></span>
        </button>`;
      })
      .join('');
    const hint = this.touch
      ? '<div class="menu-hint">Tap to choose · tap a setting to change it</div>'
      : '<div class="menu-hint">↑↓ choose · ←→ change · Enter select · Esc back</div>';
    this.layer.innerHTML = `<div class="menu-card">${s.header}<div class="menu-items">${rows}</div>${hint}</div>`;
    this.layer.querySelectorAll<HTMLElement>('.menu-item').forEach((el) => {
      const i = Number(el.dataset.i);
      el.addEventListener('mouseenter', () => {
        if (this.index !== i) {
          this.index = i;
          this.render();
        }
      });
      el.addEventListener('click', (ev) => {
        const dir = (ev.target as HTMLElement).dataset.dir;
        if (dir) {
          this.index = i;
          this.cycle(Number(dir));
        } else this.activate(i);
      });
    });
  }
}
