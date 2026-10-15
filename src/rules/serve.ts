import { Vector3 } from 'three';
import { COURT, type Side } from '../game/court';
import { topspin } from '../physics/trajectory';
import type { Player } from '../players/player';
import type { Aim, ShotButton, ShotPlan } from '../players/shots';
import type { RallyOutcome, Score, Team } from './scoring';

/** Server stands just behind the baseline; the receiver at their baseline. */
const SERVER_DEPTH = COURT.halfLength + 1.2;
const RECEIVER_DEPTH = COURT.halfLength - 0.5;
const SERVER_X = 3.5;

export interface ServeSetup {
  serverPos: Vector3;
  receiverPos: Vector3;
  /** x sign of the diagonal service box the serve must land in. */
  boxSide: number;
}

/** Where the server and receiver line up. @param fromRight serve from the server's right-hand court */
export function serveSetup(serverSide: Side, fromRight: boolean): ServeSetup {
  // The server's right is +x on the near side and -x on the far side.
  const serverX = (fromRight ? 1 : -1) * serverSide * SERVER_X;
  return {
    serverPos: new Vector3(serverX, 0, serverSide * SERVER_DEPTH),
    receiverPos: new Vector3(-serverX, 0, -serverSide * RECEIVER_DEPTH),
    boxSide: -Math.sign(serverX),
  };
}

/** Keeps the server behind the baseline and inside their half while they line up. */
export function clampServer(server: Player, setup: ServeSetup): void {
  const half = Math.sign(setup.serverPos.x);
  server.pos.z = setup.serverPos.z;
  server.pos.x = half * Math.min(COURT.halfWidth - 0.5, Math.max(0.6, half * server.pos.x));
  server.vel.z = 0;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Serve aimed with the stick: left/right picks wide vs. down the middle, up/down picks depth.
 * The Drive button serves harder and deeper (riskier); Soft is a safe, high serve.
 */
export function planServe(server: Player, setup: ServeSetup, aim: Aim, button: ShotButton, from: Vector3): ShotPlan {
  // Spin serves dip and kick but are the riskiest; Drive is hard; Soft is safe.
  const spun = button === 'spin';
  const hard = button === 'drive' || spun;
  const receiverSide = -server.side;
  const depth = Math.min(20.5, Math.max(10, (hard ? 17 : 15) + aim.y * 3));
  const boxCenter = setup.boxSide * 5;
  let x = boxCenter + server.right.x * aim.x * 3.5;
  x = setup.boxSide * Math.min(9.2, Math.max(0.8, setup.boxSide * x));
  const scatter = spun ? 1.9 : hard ? 1.4 : 0.7;
  const target = new Vector3(x + rand(-1, 1) * scatter, 0, receiverSide * (depth + rand(-1, 1) * scatter));
  return {
    target,
    flightTime: spun ? 0.95 : hard ? 1.0 : 1.4,
    spin: topspin(target.clone().sub(from), spun ? 120 : hard ? 40 : 15),
    clearance: spun ? 0.3 : hard ? 0.4 : 1.0,
  };
}

export type Court = 'right' | 'left';

/**
 * Who serves, who receives, and which half of the court (from each team's own point of view)
 * every player stands in. Singles derives everything from the score; doubles tracks it:
 *  - the serving team swaps courts each time it scores (same server keeps serving),
 *  - losing a rally on serve passes it to the partner (second server), then sides out,
 *  - after a side out (side-out scoring) the player in the right court serves first;
 *    with rally scoring, the player whose court matches the score's parity serves,
 *  - the receiving team never moves; the receiver is diagonally opposite the server.
 * Seats are each team's player slots (0 and 1).
 */
export class ServeRotation {
  /** courts[team][seat] */
  private courts: [Court[], Court[]];
  private serverSeat = 0;

  constructor(private score: Score) {
    const size = score.cfg.teamSize;
    const start = (): Court[] => (size === 2 ? ['right', 'left'] : ['right']);
    this.courts = [start(), start()];
  }

  get serverTeam(): Team {
    return this.score.servingTeam;
  }

  get server(): { team: Team; seat: number } {
    return { team: this.score.servingTeam, seat: this.score.cfg.teamSize === 2 ? this.serverSeat : 0 };
  }

  /** The court the server serves from. */
  get serverCourt(): Court {
    if (this.score.cfg.teamSize === 1) return this.score.serveFromRight() ? 'right' : 'left';
    return this.courts[this.score.servingTeam][this.serverSeat];
  }

  /** The receiving player is the one diagonally across, i.e. in the same-named court. */
  get receiver(): { team: Team; seat: number } {
    const team = this.score.receivingTeam;
    if (this.score.cfg.teamSize === 1) return { team, seat: 0 };
    return { team, seat: this.courts[team].indexOf(this.serverCourt) };
  }

  courtOf(team: Team, seat: number): Court {
    if (this.score.cfg.teamSize === 1) return this.serverCourt;
    return this.courts[team][seat];
  }

  /** Call right after Score.rallyWonBy() with what it returned. */
  afterRally(servingBefore: Team, outcome: RallyOutcome): void {
    if (this.score.cfg.teamSize === 1) return;
    if (outcome.winner === servingBefore) {
      // Scored on serve: the serving pair switches courts; the same player serves again.
      this.courts[servingBefore].reverse();
      return;
    }
    if (outcome.secondServer) {
      this.serverSeat = 1 - this.serverSeat;
      return;
    }
    // Side out.
    const team = this.score.servingTeam;
    const court: Court =
      this.score.cfg.mode === 'rally' && this.score.points[team] % 2 === 1 ? 'left' : 'right';
    this.serverSeat = this.courts[team].indexOf(court);
  }
}
