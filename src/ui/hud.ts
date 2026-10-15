import type { Vector3 } from 'three';

export type FlashKind = 'good' | 'bad' | 'info';

/** Maps a world position to screen pixels (null when off screen / behind the camera). */
export type Projector = (p: Vector3) => { x: number; y: number } | null;

/** On-screen text: an info panel and big cartoon pop-up messages. */
export class Hud {
  private panel: HTMLDivElement;
  private toasts: HTMLDivElement;
  private lastPanel = '';
  /** While true (title screen), nothing is shown. */
  muted = false;
  /** Set by the game so small tags can float above things in the 3D world. */
  projector: Projector | null = null;
  private tags: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.className = 'hud-panel';
    this.toasts = document.createElement('div');
    this.toasts.className = 'hud-toasts';
    this.tags = document.createElement('div');
    this.tags.className = 'hud-tags';
    root.append(this.panel, this.toasts, this.tags);
  }

  setPanel(html: string): void {
    this.panel.classList.toggle('hidden', this.muted);
    if (html === this.lastPanel) return;
    this.lastPanel = html;
    this.panel.innerHTML = html;
  }

  /**
   * Small label that floats up from a spot in the world and fades (timing feedback above
   * your player, "Net cord!" at the net) — out of the way of the action.
   */
  tag(text: string, kind: FlashKind, at: Vector3, ms = 850): void {
    if (this.muted) return;
    const pt = this.projector?.(at);
    if (!pt) return;
    const el = document.createElement('div');
    el.className = `tag tag-${kind}`;
    el.textContent = text;
    el.style.left = `${pt.x}px`;
    el.style.top = `${pt.y}px`;
    el.style.animationDuration = `${ms}ms`;
    this.tags.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /** Pop-up message under the scoreboard, with an optional smaller explanation line. */
  flash(text: string, kind: FlashKind = 'info', ms = 1100, detail?: string): void {
    if (this.muted) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    if (detail) {
      const d = document.createElement('div');
      d.className = 'toast-detail';
      d.textContent = detail;
      el.appendChild(d);
    }
    el.style.animationDuration = `${ms}ms`;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
}
