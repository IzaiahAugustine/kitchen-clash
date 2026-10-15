import type { Score, Team } from '../rules/scoring';

/** Top-center scoreboard: both scores, who's serving, and the pickleball score call. */
export class Scoreboard {
  private el: HTMLDivElement;
  private last = '';

  constructor(
    root: HTMLElement,
    private names: [string, string],
    private colors: [string, string],
  ) {
    this.el = document.createElement('div');
    this.el.className = 'scoreboard';
    root.append(this.el);
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

  setVisible(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
  }

  setNames(names: [string, string]): void {
    this.names = names;
    this.last = '';
  }
}
