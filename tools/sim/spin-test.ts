// Spin shots: how often do they land in, by timing grade and streak? (Should reward skill only.)
import { Vector3 } from 'three';
import { Ball } from '../../src/physics/ball';
import { solveShot } from '../../src/physics/trajectory';
import { planShot, spinStreakTiming, type ShotKind, type Timing } from '../../src/players/shots';

function landsIn(kind: ShotKind, from: Vector3, t: Timing, spun: boolean): { in: boolean; net: boolean; peak: number } {
  const plan = planShot(kind, from, 1, 'fore', { x: 0, y: 0 }, t, spun);
  const sol = solveShot({ from, target: plan.target, flightTime: plan.flightTime, spin: plan.spin, minNetClearance: plan.clearance });
  const b = new Ball();
  b.launch(from.clone(), sol.velocity, plan.spin);
  let peak = 0;
  for (let i = 0; i < 2000; i++) {
    b.step(1 / 240);
    peak = Math.max(peak, b.pos.y);
    const e = b.drainEvents().find((ev) => ev.type === 'bounce' || ev.type === 'net');
    if (!e) continue;
    if (e.type === 'net' || e.z > 0) return { in: false, net: true, peak };
    return { in: Math.abs(e.x) <= 10 && e.z >= -22, net: false, peak };
  }
  return { in: false, net: false, peak };
}

const cases: [string, ShotKind, Vector3][] = [
  ['roll off a low ball at the kitchen (1.6 ft)', 'roll', new Vector3(0, 1.6, 8.5)],
  ['roll off a mid ball at the kitchen (2.4 ft)', 'roll', new Vector3(0, 2.4, 8.5)],
  ['slice from the baseline (2.2 ft)', 'slice', new Vector3(0, 2.2, 21)],
  ['dink for comparison', 'dink', new Vector3(0, 1.6, 8.5)],
];
const grades: Timing[] = [
  { grade: 'perfect', error: 0.01 },
  { grade: 'good', error: 0.05 },
  { grade: 'late', error: 0.14 },
];
for (const [name, kind, from] of cases) {
  const row = grades.map((t) => {
    let ok = 0;
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      const r = landsIn(kind, from, t, kind !== 'dink');
      if (r.in) ok++;
      peak += r.peak;
    }
    return `${t.grade} ${Math.round((ok / 400) * 100)}% in (peak ${(peak / 400).toFixed(1)} ft)`;
  });
  console.log(name.padEnd(46), row.join(' · '));
}
// Streak: the same 'perfect' press (error 0.025) after N spin shots in a row.
for (const streak of [0, 1, 2, 3]) {
  let perfect = 0;
  for (let i = 0; i < 1000; i++) if (spinStreakTiming({ grade: 'perfect', error: 0.025 }, streak).grade === 'perfect') perfect++;
  console.log(`streak ${streak}: a 0.025s-off press is still Perfect ${perfect / 10}% of the time`);
}
