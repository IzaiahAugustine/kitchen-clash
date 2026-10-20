import type { Difficulty } from '../ai/difficulty';
import type { Team } from '../rules/scoring';
import type { MatchListener, MatchResult } from './matchMode';

/**
 * Coins, daily challenges and achievements. Everything here is plain data saved with the
 * settings; the game shows it in menus and pop-ups.
 */

/** Lifetime counters (achievements read these). */
export interface Stats {
  matches: number;
  wins: number;
  perfects: number;
  spinPerfects: number;
  smashes: number;
}

export interface ProgressState {
  coins: number;
  stats: Stats;
  /** Achievement ids earned. */
  achievements: string[];
  /** Today's challenges: which day (YYYY-MM-DD, local), each one's progress, and whether it paid out. */
  daily: { day: string; progress: number[]; done: boolean[] };
}

export const NEW_PROGRESS: ProgressState = {
  coins: 0,
  stats: { matches: 0, wins: 0, perfects: 0, spinPerfects: 0, smashes: 0 },
  achievements: [],
  daily: { day: '', progress: [0, 0, 0], done: [false, false, false] },
};

/** Things that happen in a match that challenges count. */
export type Event =
  | 'win'
  | 'winMedium'
  | 'perfect'
  | 'spinPerfect'
  | 'dink'
  | 'drop'
  | 'smash'
  | 'longRally'
  | 'ace'
  | 'point';

export interface Challenge {
  id: string;
  text: string;
  event: Event;
  target: number;
  reward: number;
}

export const CHALLENGES: Challenge[] = [
  { id: 'win', text: 'Win a match', event: 'win', target: 1, reward: 40 },
  { id: 'win-medium', text: 'Beat a Medium or Hard player', event: 'winMedium', target: 1, reward: 60 },
  { id: 'perfects', text: 'Hit 10 Perfect shots', event: 'perfect', target: 10, reward: 40 },
  { id: 'dinks', text: 'Hit 15 dinks', event: 'dink', target: 15, reward: 30 },
  { id: 'drops', text: 'Hit 8 drop shots', event: 'drop', target: 8, reward: 30 },
  { id: 'spin', text: 'Time 3 spin shots Perfect', event: 'spinPerfect', target: 3, reward: 50 },
  { id: 'smash', text: 'Hit 3 smashes', event: 'smash', target: 3, reward: 40 },
  { id: 'rally', text: 'Win a rally of 10+ shots', event: 'longRally', target: 1, reward: 50 },
  { id: 'ace', text: 'Serve an ace', event: 'ace', target: 1, reward: 40 },
  { id: 'points', text: 'Score 15 points', event: 'point', target: 15, reward: 30 },
];

export interface Achievement {
  id: string;
  name: string;
  text: string;
  reward: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'tutorial', name: 'Rookie', text: 'Finish How to Play', reward: 25 },
  { id: 'first-win', name: 'First Win', text: 'Win your first match', reward: 25 },
  { id: 'ace', name: 'Ace!', text: 'Serve an ace', reward: 30 },
  { id: 'beat-hard', name: 'Giant Slayer', text: 'Beat a Hard player', reward: 100 },
  { id: 'shutout', name: 'Shutout', text: 'Win without giving up a point', reward: 150 },
  { id: 'comeback', name: 'Comeback Kid', text: 'Win after trailing by 5', reward: 100 },
  { id: 'rally-20', name: 'Marathon', text: 'Win a rally of 20+ shots', reward: 75 },
  { id: 'wins-10', name: 'Regular', text: 'Win 10 matches', reward: 100 },
  { id: 'perfect-100', name: 'Sweet Spot', text: 'Hit 100 Perfect shots', reward: 75 },
  { id: 'spin-25', name: 'Spin Doctor', text: 'Time 25 spin shots Perfect', reward: 75 },
  { id: 'smash-50', name: 'Hammer', text: 'Hit 50 smashes', reward: 50 },
  { id: 'online-win', name: 'Friendly Rivalry', text: 'Win an online match', reward: 50 },
  { id: 'champion', name: 'Pickle Champion', text: 'Win the Tournament', reward: 200 },
  { id: 'zilla', name: 'Zilla Slayer', text: 'Beat Dinkzilla in Career', reward: 250 },
];

/** What kind of match was played (coins and some achievements depend on it). */
export interface MatchContext {
  kind: 'quick' | 'tournament' | 'online' | 'career';
  /** The opponent's level (tournament rivals count as medium). */
  opponent: Difficulty;
}

const LEVEL_PAY: Record<Difficulty, number> = { easy: 1, medium: 1.5, hard: 2 };

/** Coins for a finished match: something for playing, more for winning, scaled by the opponent. */
export function coinsForMatch(r: MatchResult, youWon: boolean, ctx: MatchContext): number {
  const you = r.youTeam ?? 0;
  const base = 10 + (youWon ? 25 : 0) + r.points[you] * 2 + Math.min(20, r.perfects);
  const scale = ctx.kind === 'tournament' ? 2 : ctx.kind === 'online' || ctx.kind === 'career' ? 1.5 : LEVEL_PAY[ctx.opponent];
  return Math.round(base * scale);
}

/** Local date as YYYY-MM-DD (challenges change at midnight where the player is). */
export function today(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The day's three challenges: picked from the date, so they're the same all day. */
export function challengesFor(day: string): Challenge[] {
  let seed = [...day].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2147483647, 7);
  const pool = [...CHALLENGES];
  const out: Challenge[] = [];
  while (out.length < 3) {
    seed = (seed * 16807) % 2147483647;
    out.push(pool.splice(seed % pool.length, 1)[0]);
  }
  return out;
}

/** A reward to announce: a finished challenge or a new achievement. */
export interface Reward {
  title: string;
  detail: string;
  coins: number;
}

export class Progress {
  /** Called whenever something pays out (to show a pop-up). */
  onReward: (r: Reward) => void = () => {};

  constructor(
    readonly state: ProgressState,
    private save: () => void,
  ) {
    this.rollDay();
  }

  get today(): Challenge[] {
    this.rollDay();
    return challengesFor(this.state.daily.day);
  }

  /** New day: fresh challenges. */
  private rollDay(): void {
    const day = today();
    if (this.state.daily.day !== day) {
      this.state.daily = { day, progress: [0, 0, 0], done: [false, false, false] };
      this.save();
    }
  }

  /** Something counted happened (n times). */
  count(event: Event, n = 1): void {
    this.rollDay();
    const d = this.state.daily;
    challengesFor(d.day).forEach((c, i) => {
      if (c.event !== event || d.done[i]) return;
      d.progress[i] = Math.min(c.target, d.progress[i] + n);
      if (d.progress[i] >= c.target) {
        d.done[i] = true;
        this.pay({ title: 'Challenge complete!', detail: c.text, coins: c.reward });
      }
    });
    this.save();
  }

  /** Earn an achievement (once). */
  achieve(id: string): void {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a || this.state.achievements.includes(id)) return;
    this.state.achievements.push(id);
    this.pay({ title: `Achievement: ${a.name}`, detail: a.text, coins: a.reward });
    this.save();
  }

  addCoins(n: number): void {
    this.state.coins += n;
    this.save();
  }

  /** Spend coins if there are enough. */
  spend(n: number): boolean {
    if (this.state.coins < n) return false;
    this.state.coins -= n;
    this.save();
    return true;
  }

  private pay(r: Reward): void {
    this.state.coins += r.coins;
    this.onReward(r);
  }

  /**
   * Watches one match for you (`you` = your team) and counts what happens. Attach the result as
   * the match's observer, then call `finish` with the result.
   */
  tracker(you: Team, ctx: MatchContext): MatchTracker {
    return new MatchTracker(this, you, ctx);
  }
}

export class MatchTracker implements Partial<MatchListener> {
  private serverTeam: Team = 0;
  private points: [number, number] = [0, 0];
  private worstDeficit = 0;

  constructor(
    private p: Progress,
    private you: Team,
    private ctx: MatchContext,
  ) {}

  serveSetup(i: { serverTeam: Team }): void {
    this.serverTeam = i.serverTeam;
  }

  hit(i: { team: Team; kind: string; grade: string; spun: boolean; human?: boolean }): void {
    if (i.team !== this.you || i.human === false) return;
    const s = this.p.state.stats;
    if (i.grade === 'perfect') {
      s.perfects++;
      this.p.count('perfect');
      if (s.perfects >= 100) this.p.achieve('perfect-100');
      if (i.spun) {
        s.spinPerfects++;
        this.p.count('spinPerfect');
        if (s.spinPerfects >= 25) this.p.achieve('spin-25');
      }
    }
    if (i.kind === 'dink') this.p.count('dink');
    if (i.kind === 'drop') this.p.count('drop');
    if (i.kind === 'smash') {
      s.smashes++;
      this.p.count('smash');
      if (s.smashes >= 50) this.p.achieve('smash-50');
    }
  }

  rallyEnd(i: { loser: Team; outcome: { pointTo: Team | null }; shots: number }): void {
    const youWon = i.loser !== this.you;
    if (i.outcome.pointTo !== null) {
      this.points[i.outcome.pointTo]++;
      if (i.outcome.pointTo === this.you) this.p.count('point');
    }
    this.worstDeficit = Math.max(this.worstDeficit, this.points[1 - this.you] - this.points[this.you]);
    if (!youWon) return;
    if (i.shots === 1 && this.serverTeam === this.you) {
      this.p.count('ace');
      this.p.achieve('ace');
    }
    if (i.shots >= 10) this.p.count('longRally');
    if (i.shots >= 20) this.p.achieve('rally-20');
  }

  /** The match is over: count the result. Returns the coins earned for playing it. */
  finish(r: MatchResult, youWon: boolean): number {
    const s = this.p.state.stats;
    s.matches++;
    if (youWon) {
      s.wins++;
      this.p.count('win');
      if (this.ctx.opponent !== 'easy' || this.ctx.kind !== 'quick') this.p.count('winMedium');
      this.p.achieve('first-win');
      if (s.wins >= 10) this.p.achieve('wins-10');
      if (this.ctx.kind === 'quick' && this.ctx.opponent === 'hard') this.p.achieve('beat-hard');
      if (this.ctx.kind === 'online') this.p.achieve('online-win');
      if (r.points[1 - this.you] === 0) this.p.achieve('shutout');
      if (this.worstDeficit >= 5) this.p.achieve('comeback');
    }
    const coins = coinsForMatch(r, youWon, this.ctx);
    this.p.addCoins(coins);
    return coins;
  }
}
