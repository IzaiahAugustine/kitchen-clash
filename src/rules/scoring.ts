import type { Side } from '../game/court';

export type ScoringMode = 'sideout' | 'rally';
/** Team 0 plays the near (+z) side, team 1 the far side. */
export type Team = 0 | 1;

export const sideOfTeam = (t: Team): Side => (t === 0 ? 1 : -1);
export const teamOfSide = (s: Side): Team => (s === 1 ? 0 : 1);
export const otherTeam = (t: Team): Team => (t === 0 ? 1 : 0);

export interface ScoreConfig {
  mode: ScoringMode;
  /** Points needed to win a game. */
  target: number;
  winBy: number;
  /** 1 = singles, 2 = doubles. */
  teamSize: 1 | 2;
}

export const DEFAULT_SCORING: ScoreConfig = { mode: 'sideout', target: 11, winBy: 2, teamSize: 1 };

export interface RallyOutcome {
  winner: Team;
  /** Team that scored, or null when only the serve changed hands. */
  pointTo: Team | null;
  /** Serve passed to the other team. */
  sideOut: boolean;
  /** Doubles: serve passed to the partner (second server). */
  secondServer: boolean;
}

/**
 * Pickleball scoring.
 * Side-out: only the serving team scores; losing a rally on serve passes the serve
 * (in doubles, to the second server first). Rally: every rally scores, winner serves.
 */
export class Score {
  readonly points: [number, number] = [0, 0];
  servingTeam: Team;
  /** Doubles server number (1 or 2). Always 1 in singles. */
  serverNumber: 1 | 2;

  constructor(
    readonly cfg: ScoreConfig,
    firstServingTeam: Team,
  ) {
    this.servingTeam = firstServingTeam;
    // Doubles side-out: the team serving first only gets one server ("0-0-2").
    this.serverNumber = cfg.teamSize === 2 && cfg.mode === 'sideout' ? 2 : 1;
  }

  get receivingTeam(): Team {
    return otherTeam(this.servingTeam);
  }

  rallyWonBy(team: Team): RallyOutcome {
    if (this.cfg.mode === 'rally') {
      this.points[team]++;
      const sideOut = team !== this.servingTeam;
      if (sideOut) {
        this.servingTeam = team;
        this.serverNumber = 1;
      }
      return { winner: team, pointTo: team, sideOut, secondServer: false };
    }
    if (team === this.servingTeam) {
      this.points[team]++;
      return { winner: team, pointTo: team, sideOut: false, secondServer: false };
    }
    if (this.cfg.teamSize === 2 && this.serverNumber === 1) {
      this.serverNumber = 2;
      return { winner: team, pointTo: null, sideOut: false, secondServer: true };
    }
    this.servingTeam = this.receivingTeam;
    this.serverNumber = 1;
    return { winner: team, pointTo: null, sideOut: true, secondServer: false };
  }

  winner(): Team | null {
    for (const t of [0, 1] as Team[]) {
      const lead = this.points[t] - this.points[otherTeam(t)];
      if (this.points[t] >= this.cfg.target && lead >= this.cfg.winBy) return t;
    }
    return null;
  }

  /** Team that would win the game by winning the next rally, if any. */
  gamePointFor(): Team | null {
    const candidates: Team[] = this.cfg.mode === 'rally' ? [0, 1] : [this.servingTeam];
    for (const t of candidates) {
      const next = this.points[t] + 1;
      if (next >= this.cfg.target && next - this.points[otherTeam(t)] >= this.cfg.winBy) return t;
    }
    return null;
  }

  /** Called before each serve: server's score first. "4-2" in singles, "4-2-1" in doubles. */
  call(): string {
    const s = this.points[this.servingTeam];
    const r = this.points[this.receivingTeam];
    return this.cfg.teamSize === 2 && this.cfg.mode === 'sideout' ? `${s}-${r}-${this.serverNumber}` : `${s}-${r}`;
  }

  /** Singles: serve from the right-hand court on an even score, the left on odd. */
  serveFromRight(): boolean {
    return this.points[this.servingTeam] % 2 === 0;
  }
}
