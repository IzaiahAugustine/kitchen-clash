import './style.css';
import { Game } from './game/game';
import { hasDebugFlag } from './game/debugFlags';
import { portal } from './platform/portal';

// `?nohud` hides all on-screen text (for clean screenshots).
if (hasDebugFlag('nohud')) document.body.classList.add('nohud');

async function boot() {
  // game portal SDK (no-op off-portal); never hold the game up for it
  await Promise.race([portal.init(), new Promise((r) => setTimeout(r, 6000))]);
  const game = new Game(document.getElementById('app')!, document.getElementById('ui')!);
  await game.start();
  portal.loadingFinished();
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('ui')!.innerHTML = `<div class="fatal">Couldn't start the game: ${String(err)}</div>`;
});
