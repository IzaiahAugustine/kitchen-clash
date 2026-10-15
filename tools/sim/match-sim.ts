// Headless match simulation: two AIs play full games under the real rules.
// Usage: npx tsx tools/sim/match-sim.ts [games] [nearDifficulty] [farDifficulty] [sideout|rally]
import * as THREE from 'three';
import { PROFILES, parseDifficulty } from '../../src/ai/difficulty';
import { MatchMode } from '../../src/game/matchMode';
import type { World } from '../../src/game/mode';
import { Ball } from '../../src/physics/ball';
import { PHYS } from '../../src/physics/constants';
import { DEFAULT_SCORING } from '../../src/rules/scoring';

const games = Number(process.argv[2] ?? 5);
const near = parseDifficulty(process.argv[3]);
const far = parseDifficulty(process.argv[4]);
const mode = process.argv[5] === 'rally' ? 'rally' : 'sideout';
// Optional profile tweaks for tuning, e.g. AI_TWEAK='{"hard":{"blunder":0.06}}'
const tweak = JSON.parse(process.env.AI_TWEAK ?? '{}') as Record<string, object>;
for (const [k, v] of Object.entries(tweak)) Object.assign(PROFILES[parseDifficulty(k)], v);
const ball = new Ball();
const world = {
  scene: new THREE.Scene(),
  ball,
  ballView: { clearTrail() {} },
  hud: { flash() {}, tag() {} },
  keys: {},
  controls: { frame: { moveX: 0, moveY: 0, drive: false, soft: false, feed: false, pause: false } },
} as unknown as World;

const match = new MatchMode(world, null, null, { scoring: { ...DEFAULT_SCORING, mode }, near, far });
let time = 0;
let acc = 0;
const frame = 1 / 60;
let done = 0;
let seen = 0;
const reasons = new Map<string, number>();
const wins = [0, 0];
const ralliesLost = [0, 0];
const scores: string[] = [];
let rallies = 0;
for (let f = 0; f < 60 * 60 * 600 && done < games; f++) {
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
    const [kind, team, score] = h[seen].split(':');
    if (kind === 'game') {
      wins[Number(team)]++;
      scores.push(`${team === '0' ? near : far} ${score}`);
      done++;
    } else {
      rallies++;
      ralliesLost[Number(team)]++;
      const key = `${kind} (${team === '0' ? near : far})`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
}
console.log(`${near} (near) vs ${far} (far), ${mode}: ${done} games, ${rallies} rallies, avg ${(time / Math.max(1, rallies)).toFixed(1)}s per rally`);
console.log(`Wins: ${near} ${wins[0]} – ${wins[1]} ${far}   [${scores.join(', ')}]`);
console.log(`Rallies won: ${near} ${((100 * ralliesLost[1]) / Math.max(1, rallies)).toFixed(0)}% – ${((100 * ralliesLost[0]) / Math.max(1, rallies)).toFixed(0)}% ${far}`);
console.log('How rallies ended (who lost the rally):');
for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
