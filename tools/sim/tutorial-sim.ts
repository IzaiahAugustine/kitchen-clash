// Plays through How to Play with a scripted "player" to check every step can be completed.
// Usage: npx tsx tools/sim/tutorial-sim.ts
import * as THREE from 'three';
import { TutorialMode } from '../../src/game/tutorialMode';
import type { World } from '../../src/game/mode';
import { Ball } from '../../src/physics/ball';
import { PHYS } from '../../src/physics/constants';
import { predictPath } from '../../src/physics/predict';
import { IDEAL_LEAD, findContact } from '../../src/players/hitting';

// Minimal DOM stand-in for the instruction card.
const el = () => ({ className: '', innerHTML: '', addEventListener() {}, appendChild() {}, remove() {} });
(globalThis as unknown as { document: unknown }).document = { createElement: el };

const ball = new Ball();
const frame = { moveX: 0, moveY: 0, drive: false, soft: false, power: false, feed: false, pause: false };
const log: string[] = [];
const world = {
  scene: new THREE.Scene(),
  ball,
  ballView: { clearTrail() {}, squash() {} },
  hud: { flash: (t: string) => log.push(`flash ${t}`), tag: (t: string) => log.push(`tag ${t}`) },
  keys: { wasPressed: () => false },
  controls: { frame },
} as unknown as World;

let done = false;
const tut = new TutorialMode(world, null, el() as unknown as HTMLElement, false);
tut.onComplete = () => (done = true);
const t = tut as unknown as { step: number; you: { pos: THREE.Vector3; side: 1 }; moveTarget: THREE.Vector3; current: { id: string } };

let time = 0;
let acc = 0;
let lastStep = -1;
let stepStart = 0;
const stepTimes: string[] = [];
for (let f = 0; f < 60 * 400 && !done; f++) {
  // --- scripted player
  const id = t.current.id;
  if (t.step !== lastStep) {
    if (lastStep >= 0) stepTimes.push(`${lastStep + 1}:${(time - stepStart).toFixed(1)}s`);
    lastStep = t.step;
    stepStart = time;
  }
  frame.moveX = frame.moveY = 0;
  frame.drive = frame.soft = frame.power = false;
  const you = t.you;
  if (id === 'move') {
    const dx = t.moveTarget.x - you.pos.x;
    const dz = t.moveTarget.z - you.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    frame.moveX = dx / d;
    frame.moveY = -dz / d;
  } else if (id === 'rules' || id === 'serve') {
    if (f % 90 === 0) frame[id === 'serve' && f % 180 === 0 ? 'soft' : 'drive'] = true;
    if (id === 'serve') frame.soft = f % 120 === 0;
    if (id === 'rules') frame.drive = f % 60 === 0;
  } else if (ball.inPlay) {
    const c = findContact(you as never, { path: predictPath(ball), bouncesSoFar: 0, maxTime: 1.5, slack: 2.6, mustBounce: id === 'dink' }, ball.flight);
    if (c && Math.abs(c.t - IDEAL_LEAD) < 1 / 60) frame[id === 'soft' ? 'soft' : id === 'power' ? 'power' : 'drive'] = true;
  }
  // --- run a frame
  acc += 1 / 60;
  while (acc >= PHYS.fixedDt) {
    tut.fixedUpdate(PHYS.fixedDt, time);
    ball.step(PHYS.fixedDt);
    time += PHYS.fixedDt;
    for (const e of ball.drainEvents()) tut.onBallEvent(e);
    acc -= PHYS.fixedDt;
  }
  tut.update(1 / 60, time);
}
stepTimes.push(`${lastStep + 1}:${(time - stepStart).toFixed(1)}s`);
console.log(done ? `Tutorial completed in ${time.toFixed(0)}s` : `NOT completed: stuck on step ${t.step + 1} (${t.current.id})`);
console.log('Time per step:', stepTimes.join('  '));
const counts = new Map<string, number>();
for (const l of log) counts.set(l, (counts.get(l) ?? 0) + 1);
console.log('Messages:', [...counts.entries()].map(([k, v]) => `${k} ×${v}`).join(', '));
