// Headless rally simulation: runs Practice mode with bots on both sides and reports how
// rallies end. Usage: npx tsx tools/sim/practice-sim.ts [seconds]
import * as THREE from 'three';
import { PracticeMode } from '../../src/game/practiceMode';
import type { World } from '../../src/game/mode';
import { Ball } from '../../src/physics/ball';
import { PHYS } from '../../src/physics/constants';

const seconds = Number(process.argv[2] ?? 600);
const flashes = new Map<string, number>();
const ball = new Ball();
const world = {
  scene: new THREE.Scene(),
  ball,
  ballView: { clearTrail() {} },
  hud: { flash: (text: string) => flashes.set(text, (flashes.get(text) ?? 0) + 1) },
  keys: {},
  controls: { frame: { moveX: 0, moveY: 0, drive: false, soft: false, feed: false, pause: false }, pad: { connected: false } },
} as unknown as World;

const mode = new PracticeMode(world, null, true);
// Optional 2nd arg: timing sloppiness of the simulated human (seconds).
const noise = Number(process.argv[3] ?? 0.035);
(mode as unknown as { autopilot: { timingNoise: number } }).autopilot.timingNoise = noise;
let time = 0;
let acc = 0;
const frame = 1 / 60;
const rallies: number[] = [];
let lastRally = 0;
let lastShot = '';
const kinds = new Map<string, number>();
for (let f = 0; f < seconds * 60; f++) {
  acc += frame;
  while (acc >= PHYS.fixedDt) {
    mode.fixedUpdate(PHYS.fixedDt, time);
    ball.step(PHYS.fixedDt);
    time += PHYS.fixedDt;
    for (const e of ball.drainEvents()) mode.onBallEvent(e);
    acc -= PHYS.fixedDt;
  }
  mode.update(frame, time);
  const m = /Rally (\d+)/.exec(mode.describe());
  const r = m ? Number(m[1]) : 0;
  if (r < lastRally) rallies.push(lastRally);
  lastRally = r;
  const shot = /Last shot: ([^·<]+)/.exec(mode.describe())?.[1]?.trim() ?? '';
  if (shot !== lastShot) {
    lastShot = shot;
    kinds.set(shot, (kinds.get(shot) ?? 0) + 1);
  }
}
console.log('Your side shot mix:', Object.fromEntries(kinds));
const sorted = [...flashes.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${seconds}s simulated, ${rallies.length} rallies, avg length ${(rallies.reduce((a, b) => a + b, 0) / Math.max(1, rallies.length)).toFixed(1)} hits`);
for (const [k, v] of sorted) console.log(`  ${k.padEnd(18)} ${v}`);
