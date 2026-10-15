/** True on phones and tablets (a touch screen without a precise pointer). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
}

const STICK_RADIUS = 56;

/**
 * On-screen controls for phones: a floating thumb stick on the left half of the screen
 * (it appears wherever your thumb lands), HIT and SOFT buttons on the right, and a pause
 * button. Reads like a gamepad: a stick vector plus button presses.
 */
export class TouchControls {
  private root: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private stickId: number | null = null;
  private origin = { x: 0, y: 0 };
  private vec = { x: 0, y: 0 };
  private pressedNow = new Set<string>();
  private visible = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-ui hidden';
    this.root.innerHTML = `
      <div class="touch-zone"></div>
      <div class="touch-stick"><div class="touch-knob"></div></div>
      <button class="touch-btn touch-hit" data-btn="drive">HIT</button>
      <button class="touch-btn touch-soft" data-btn="soft">SOFT</button>
      <button class="touch-btn touch-spin" data-btn="spin">SPIN</button>
      <button class="touch-btn touch-pause" data-btn="pause" aria-label="Pause">❚❚</button>`;
    parent.appendChild(this.root);
    this.base = this.root.querySelector('.touch-stick')!;
    this.knob = this.root.querySelector('.touch-knob')!;

    const zone = this.root.querySelector<HTMLElement>('.touch-zone')!;
    zone.addEventListener('touchstart', (e) => this.stickStart(e), { passive: false });
    zone.addEventListener('touchmove', (e) => this.stickMove(e), { passive: false });
    zone.addEventListener('touchend', (e) => this.stickEnd(e));
    zone.addEventListener('touchcancel', (e) => this.stickEnd(e));
    this.root.querySelectorAll<HTMLElement>('.touch-btn').forEach((b) => {
      b.addEventListener(
        'touchstart',
        (e) => {
          e.preventDefault();
          this.pressedNow.add(b.dataset.btn!);
          b.classList.add('down');
        },
        { passive: false },
      );
      const up = () => b.classList.remove('down');
      b.addEventListener('touchend', up);
      b.addEventListener('touchcancel', up);
    });
  }

  /** Show the controls during play, hide them in menus. */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }

  /** Stick vector, -1..1, y positive = up (toward the net). */
  stick(): { x: number; y: number } {
    return this.vec;
  }

  /** Was this button tapped since the last frame? Clears it. */
  take(name: 'drive' | 'soft' | 'spin' | 'pause'): boolean {
    const had = this.pressedNow.has(name);
    this.pressedNow.delete(name);
    return had;
  }

  private stickStart(e: TouchEvent): void {
    e.preventDefault();
    if (this.stickId !== null) return;
    const t = e.changedTouches[0];
    this.stickId = t.identifier;
    this.origin = { x: t.clientX, y: t.clientY };
    this.base.style.left = `${t.clientX}px`;
    this.base.style.top = `${t.clientY}px`;
    this.base.classList.add('active');
    this.moveKnob(0, 0);
  }

  private stickMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.stickId) continue;
      let dx = t.clientX - this.origin.x;
      let dy = t.clientY - this.origin.y;
      const d = Math.hypot(dx, dy);
      if (d > STICK_RADIUS) {
        dx *= STICK_RADIUS / d;
        dy *= STICK_RADIUS / d;
      }
      this.moveKnob(dx, dy);
      // Small dead zone, then full range.
      const m = Math.hypot(dx, dy) / STICK_RADIUS;
      const k = m < 0.15 ? 0 : Math.min(1, (m - 0.15) / 0.85) / (m || 1);
      this.vec = { x: (dx / STICK_RADIUS) * k, y: (-dy / STICK_RADIUS) * k };
    }
  }

  private stickEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) this.reset();
    }
  }

  private moveKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private reset(): void {
    this.stickId = null;
    this.vec = { x: 0, y: 0 };
    this.base.classList.remove('active');
    this.moveKnob(0, 0);
    this.pressedNow.clear();
  }
}
