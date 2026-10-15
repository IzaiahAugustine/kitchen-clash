export type FlashKind = 'good' | 'bad' | 'info';

/** On-screen text: an info panel and big cartoon pop-up messages. */
export class Hud {
  private panel: HTMLDivElement;
  private toasts: HTMLDivElement;
  private lastPanel = '';
  /** While true (title screen), nothing is shown. */
  muted = false;

  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.className = 'hud-panel';
    this.toasts = document.createElement('div');
    this.toasts.className = 'hud-toasts';
    root.append(this.panel, this.toasts);
  }

  setPanel(html: string): void {
    this.panel.classList.toggle('hidden', this.muted);
    if (html === this.lastPanel) return;
    this.lastPanel = html;
    this.panel.innerHTML = html;
  }

  /** Big pop-up message, with an optional smaller explanation line under it. */
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
