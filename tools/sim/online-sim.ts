// Plays an online match between a scripted host and a scripted guest over an in-memory channel
// with artificial lag, to check the two screens stay in sync. Usage: npx tsx tools/sim/online-sim.ts [lagMs] [timingNoise]
import * as THREE from 'three';
import type { World } from '../../src/game/mode';
import { loopbackPair } from '../../src/net/channel';
import { OnlineGuest } from '../../src/net/onlineGuest';
import { OnlineHost } from '../../src/net/onlineHost';
import { Ball } from '../../src/physics/ball';
import { PHYS } from '../../src/physics/constants';
import { predictPath } from '../../src/physics/predict';
import { IDEAL_LEAD, findContact } from '../../src/players/hitting';
import type { Player } from '../../src/players/player';
import { DEFAULT_SCORING } from '../../src/rules/scoring';

const lag = Number(process.argv[2] ?? 50);
/** Timing sloppiness of the scripted players (s), so points actually end. */
const noise = Number(process.argv[3] ?? 0.15);
const leads = new Map<Player, { flight: number; lead: number }>();
const makeWorld = (log: string[]) => {
  const frame = { moveX: 0, moveY: 0, drive: false, soft: false, power: false, feed: false, pause: false };
  return {
    world: {
      scene: new THREE.Scene(),
      ball: new Ball(),
      ballView: { clearTrail() {}, squash() {} },
      hud: { flash: (t: string, _k: string, _m: number, d?: string) => log.push(`${t}${d ? ' — ' + d : ''}`), tag: (t: string) => log.push(`tag:${t}`) },
      keys: { wasPressed: () => false },
      controls: { frame },
    } as unknown as World,
    frame,
  };
};
const hostLog: string[] = [];
const guestLog: string[] = [];
const H = makeWorld(hostLog);
const G = makeWorld(guestLog);
const [hc, gc, pump] = loopbackPair(lag);
const host = new OnlineHost(H.world, null, null, hc, 'Izaiah', 'Friend', DEFAULT_SCORING);
const guest = new OnlineGuest(G.world, null, null, gc, 'Izaiah');
let over: unknown = null;
guest.onGameOver = (r) => (over = r);

/** A decent scripted player: walks to the ball and presses at the ideal moment. */
function drive(frame: typeof H.frame, me: Player, ball: Ball, incoming: boolean, serving: boolean, f: number) {
  frame.moveX = frame.moveY = 0;
  frame.drive = frame.soft = frame.power = false;
  if (serving) {
    frame.soft = f % 100 === 50;
    return;
  }
  if (!incoming || !ball.inPlay) return;
  const c = findContact(me, { path: predictPath(ball), bouncesSoFar: 0, maxTime: 1.6, slack: 2.6, bestEffort: true }, ball.flight);
  if (!c) return;
  const dx = c.standAt.x - me.pos.x;
  const dz = c.standAt.z - me.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.5) {
    frame.moveX = (dx / d) * me.right.x;
    frame.moveY = (dz / d) * me.forward.z;
  }
  let l = leads.get(me);
  if (!l || l.flight !== ball.flight) leads.set(me, (l = { flight: ball.flight, lead: IDEAL_LEAD + (Math.random() * 2 - 1) * noise }));
  if (Math.abs(c.t - l.lead) < 1 / 60) frame.drive = true;
}

let time = 0;
let acc = 0;
const hm = host.match as unknown as { phase: string; lastHitter: { team: number } | null; seats: { player: Player }[]; server: { team: number } };
const gm = guest as unknown as { me: Player; phase: string; lastHitterTeam: number; serverTeam: number; score: { points: number[] } };
for (let f = 0; f < 60 * 900 && !over; f++) {
  drive(H.frame, hm.seats[0].player, H.world.ball, hm.phase === 'rally' && hm.lastHitter?.team !== 0, hm.phase === 'preServe' && hm.server.team === 0, f);
  drive(G.frame, gm.me, G.world.ball, gm.phase === 'rally' && gm.lastHitterTeam !== 1, gm.phase === 'preServe' && gm.serverTeam === 1, f);
  acc += 1 / 60;
  while (acc >= PHYS.fixedDt) {
    for (const [mode, w] of [[host, H.world], [guest, G.world]] as const) {
      mode.fixedUpdate(PHYS.fixedDt, time);
      w.ball.step(PHYS.fixedDt);
      for (const e of w.ball.drainEvents()) mode.onBallEvent(e, time);
    }
    time += PHYS.fixedDt;
    acc -= PHYS.fixedDt;
  }
  pump(time * 1000);
  host.update(1 / 60, time);
  guest.update(1 / 60, time);
}
const hs = host.match.currentScore;
console.log(`lag ${lag} ms each way · ${over ? 'game finished' : 'NOT finished'} after ${(time / 60).toFixed(1)} min`);
console.log(`host score ${hs.points.join('-')} · guest sees ${gm.score.points.join('-')}`);
const count = (log: string[], p: string) => log.filter((l) => l.startsWith(p)).length;
console.log(`guest timing tags: Perfect ${count(guestLog, 'tag:Perfect')}, Nice ${count(guestLog, 'tag:Nice')}, Early ${count(guestLog, 'tag:Early')}, Late ${count(guestLog, 'tag:Late')}`);
console.log(`host timing tags:  Perfect ${count(hostLog, 'tag:Perfect')}, Nice ${count(hostLog, 'tag:Nice')}, Early ${count(hostLog, 'tag:Early')}, Late ${count(hostLog, 'tag:Late')}`);
const why = new Map<string, number>();
for (const l of hostLog) {
  const m = / — (You|FRIEND): (.*?) ·/.exec(l);
  if (m) why.set(`${m[1] === 'You' ? 'host' : 'guest'} lost: ${m[2]}`, (why.get(`${m[1] === 'You' ? 'host' : 'guest'} lost: ${m[2]}`) ?? 0) + 1);
}
console.log([...why.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k} ×${v}`).join('\n'));
console.log('rally endings (guest view):', guestLog.filter((l) => / — (You|Izaiah):/.test(l)).slice(0, 6).join(' | '));
