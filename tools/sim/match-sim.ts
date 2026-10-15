// Headless match simulation: bots play full games under the real rules.
// Usage: npx tsx tools/sim/match-sim.ts [games] [sideout|rally] [timingNoise]
import * as THREE from 'three';
import { MatchMode } from '../../src/game/matchMode';
import type { World } from '../../src/game/mode';
import { Ball } from '../../src/physics/ball';
import { PHYS } from '../../src/physics/constants';
import { DEFAULT_SCORING } from '../../src/rules/scoring';

const games = Number(process.argv[2] ?? 5);
const mode = process.argv[3] === 'rally' ? 'rally' : 'sideout';
const ball = new Ball();
const world = {
  scene: new THREE.Scene(),
  ball,
  ballView: { clearTrail() {} },
  hud: { flash() {} },
  keys: {},
  controls: { frame: { moveX: 0, moveY: 0, drive: false, soft: false, feed: false, pause: false } },
} as unknown as World;

const match = new MatchMode(world, null, null, { ...DEFAULT_SCORING, mode }, true);
// Optional 3rd arg: timing sloppiness (s) for both bots, so rallies end in a variety of faults.
const noise = Number(process.argv[4] ?? 0.1);
const m = match as unknown as { autopilot: { timingNoise: number }; botAi: { timingNoise: number } };
m.autopilot.timingNoise = noise;
m.botAi.timingNoise = noise;
let time = 0;
let acc = 0;
const frame = 1 / 60;
let done = 0;
let seen = 0;
const reasons = new Map<string, number>();
const results: string[] = [];
let rallies = 0;
for (let f = 0; f < 60 * 60 * 60 && done < games; f++) {
  acc += frame;
  while (acc >= PHYS.fixedDt) {
    match.fixedUpdate(PHYS.fixedDt, time);
    ball.step(PHYS.fixedDt);
    time += PHYS.fixedDt;
    for (const e of ball.drainEvents()) match.onBallEvent(e);
    acc -= PHYS.fixedDt;
  }
  match.update(frame, time);
  const h = match.history;
  for (; seen < h.length; seen++) {
    const entry = h[seen];
    if (entry.startsWith('game:')) {
      results.push(entry);
      done++;
    } else {
      rallies++;
      const reason = entry.split(':')[0];
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
}
console.log(`${mode} scoring: ${done} games in ${(time / 60).toFixed(1)} min of play, ${rallies} rallies`);
console.log('Results:', results.join('  '));
console.log('How rallies ended:');
for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
