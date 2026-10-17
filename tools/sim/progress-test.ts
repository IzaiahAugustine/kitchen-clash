// Checks coins, daily challenges and achievements: npx tsx tools/sim/progress-test.ts
import { CHALLENGES, NEW_PROGRESS, Progress, challengesFor, coinsForMatch, today } from '../../src/game/progress';
import type { MatchResult } from '../../src/game/matchMode';

let failed = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const fresh = () => structuredClone(NEW_PROGRESS);
const result = (points: [number, number], winner: 0 | 1): MatchResult => ({
  winner, names: ['YOU', 'CPU'], points, longestRally: 8, perfects: 6, ralliesWon: [11, 4], humanTeam: true,
});

// Coins: more for winning, for harder opponents, for the tournament.
const win = result([11, 4], 0);
const loss = result([7, 11], 1);
check(coinsForMatch(win, true, { kind: 'quick', opponent: 'easy' }) > coinsForMatch(loss, false, { kind: 'quick', opponent: 'easy' }), 'a win pays more than a loss');
check(coinsForMatch(loss, false, { kind: 'quick', opponent: 'easy' }) > 0, 'a loss still pays something');
check(coinsForMatch(win, true, { kind: 'quick', opponent: 'hard' }) > coinsForMatch(win, true, { kind: 'quick', opponent: 'easy' }), 'hard pays more than easy');

// Daily challenges: three different ones, the same all day, different on other days.
const day = challengesFor('2026-10-17');
check(new Set(day.map((c) => c.id)).size === 3, 'three different challenges a day');
check(JSON.stringify(challengesFor('2026-10-17')) === JSON.stringify(day), 'same challenges all day');
const varied = new Set(Array.from({ length: 20 }, (_, i) => challengesFor(`2026-11-${String(i + 1).padStart(2, '0')}`).map((c) => c.id).join()));
check(varied.size > 10, 'challenges change from day to day');
check(CHALLENGES.every((c) => c.target > 0 && c.reward > 0), 'every challenge has a target and reward');

// A whole match through the tracker.
const state = fresh();
let saves = 0;
const rewards: string[] = [];
const p = new Progress(state, () => saves++);
p.onReward = (r) => rewards.push(r.title);
check(state.daily.day === today(), "today's challenges are set up");
const t = p.tracker(0, { kind: 'quick', opponent: 'hard' });
t.serveSetup({ serverTeam: 0 });
t.rallyEnd({ loser: 1, outcome: { pointTo: 0 }, shots: 1 }); // ace
for (let i = 0; i < 12; i++) t.hit({ team: 0, kind: 'dink', grade: 'perfect', spun: i < 4, human: true });
t.hit({ team: 1, kind: 'smash', grade: 'perfect', spun: false, human: false }); // the opponent's: not counted
for (let i = 0; i < 6; i++) t.rallyEnd({ loser: 0, outcome: { pointTo: 1 }, shots: 4 }); // down 1-6
for (let i = 0; i < 10; i++) t.rallyEnd({ loser: 1, outcome: { pointTo: 0 }, shots: i === 0 ? 22 : 3 });
const coins = t.finish(result([11, 6], 0), true);
check(state.stats.perfects === 12 && state.stats.spinPerfects === 4 && state.stats.smashes === 0, `lifetime counts (${JSON.stringify(state.stats)})`);
for (const id of ['first-win', 'ace', 'beat-hard', 'comeback', 'rally-20']) check(state.achievements.includes(id), `achievement ${id}`);
check(!state.achievements.includes('shutout'), 'no shutout when the opponent scored');
check(coins > 0 && state.coins >= coins, `coins added (${coins} for the match, ${state.coins} total)`);
check(rewards.length >= 5 && saves > 0, `rewards announced (${rewards.length}) and saved`);
const before = state.coins;
p.achieve('ace');
check(state.coins === before, 'an achievement only pays once');

// Spending.
check(!p.spend(state.coins + 1), "can't spend more than you have");
check(p.spend(10) && state.coins === before - 10, 'spending takes the coins');

console.log(failed ? `\n${failed} FAILED` : '\nAll progress tests passed');
process.exit(failed ? 1 : 0);
