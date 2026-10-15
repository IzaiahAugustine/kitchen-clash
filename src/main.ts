import './style.css';
import { Game } from './game/game';
import { hasDebugFlag } from './game/debugFlags';

// `?nohud` hides all on-screen text (for clean screenshots).
if (hasDebugFlag('nohud')) document.body.classList.add('nohud');

const game = new Game(document.getElementById('app')!, document.getElementById('ui')!);
game.start().catch((err) => {
  console.error(err);
  document.getElementById('ui')!.innerHTML = `<div class="fatal">Couldn't start the game: ${String(err)}</div>`;
});
