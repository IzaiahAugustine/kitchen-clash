import type { Score, Team } from '../rules/scoring';

/** Top-center scoreboard: both scores, who's serving, and the pickleball score call. */
export class Scoreboard {
  private el: HTMLDivElement;
  private overlay: HTMLDivElement;
  private last = '';

  constructor(root: HTMLElement, private names: [string, string], private colors: [string, string]) {
    this.el = document.createElement('div');
    this.el.className = 'scoreboard';
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    this.overlay.style.display = 'none';
    root.append(this.el, this.overlay);
  }

  update(score: Score): void {
    const team = (t: Team) => `
      <div class="sb-team ${score.servingTeam === t ? 'serving' : ''}" style="background:${this.colors[t]}">
        ${t === 0 ? `<span class="serve-dot"></span><span>${this.names[t]}</span><span class="pts">${score.points[t]}</span>` : `<span class="pts">${score.points[t]}</span><span>${this.names[t]}</span><span class="serve-dot"></span>`}
      </div>`;
    const mode = score.cfg.mode === 'rally' ? 'Rally scoring' : 'Side-out';
    const html = `${team(0)}<div class="sb-mid">${score.call()}<small>${mode} · to ${score.cfg.target}</small></div>${team(1)}`;
    if (html !== this.last) {
      this.last = html;
      this.el.innerHTML = html;
    }
  }

  showGameOver(title: string, line: string): void {
    this.overlay.innerHTML = `<div class="card"><h1>${title}</h1><p>${line}</p><p>Press <b>Enter</b> for a rematch</p></div>`;
    this.overlay.style.display = 'grid';
  }

  hideGameOver(): void {
    this.overlay.style.display = 'none';
  }
}
