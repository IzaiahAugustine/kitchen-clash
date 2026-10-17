/**
 * Picture-style control hints along the bottom of the screen: key caps instead of sentences.
 * New players see the full strip; anyone about to serve sees the serve keys.
 */
export class Coach {
  private el: HTMLDivElement;
  private last = '';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'coach hidden';
    root.append(this.el);
  }

  /** `what`: which strip to show, or null to hide it. */
  show(what: 'controls' | 'serve' | null): void {
    const html = what === 'serve' ? SERVE : what === 'controls' ? CONTROLS : '';
    this.el.classList.toggle('hidden', !html);
    if (html && html !== this.last) {
      this.last = html;
      this.el.innerHTML = html;
    }
  }
}

const key = (k: string, wide = false) => `<span class="cap${wide ? ' wide' : ''}">${k}</span>`;
const group = (keys: string, label: string, cls = '') => `<div class="coach-group ${cls}"><div class="caps">${keys}</div><div class="coach-label">${label}</div></div>`;

const move = `<div class="caps-grid"><span></span>${key('W')}<span></span>${key('A')}${key('S')}${key('D')}</div><span class="or">or</span><div class="caps-grid"><span></span>${key('↑')}<span></span>${key('←')}${key('↓')}${key('→')}</div>`;

const CONTROLS =
  group(move, 'Move') +
  group(key('J') + key('Z'), 'Drive', 'drive') +
  group(key('K') + key('X'), 'Soft', 'soft') +
  group(key('L') + key('C'), 'Spin', 'spin') +
  group(key('P'), 'Pause');

const SERVE =
  `<div class="coach-title">Your serve!</div>` +
  group(key('A') + key('D') + '<span class="or">or</span>' + key('←') + key('→'), 'Aim') +
  group(key('J'), 'Hard', 'drive') +
  group(key('K'), 'Safe', 'soft') +
  group(key('L'), 'Spin', 'spin');
