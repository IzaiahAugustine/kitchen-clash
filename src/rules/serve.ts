import { Vector3 } from 'three';
import { COURT, type Side } from '../game/court';
import { topspin } from '../physics/trajectory';
import type { Player } from '../players/player';
import type { Aim, ShotButton, ShotPlan } from '../players/shots';

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
  const hard = button === 'drive';
  const receiverSide = -server.side;
  const depth = Math.min(20.5, Math.max(10, (hard ? 17 : 15) + aim.y * 3));
  const boxCenter = setup.boxSide * 5;
  let x = boxCenter + server.right.x * aim.x * 3.5;
  x = setup.boxSide * Math.min(9.2, Math.max(0.8, setup.boxSide * x));
  const scatter = hard ? 1.4 : 0.7;
  const target = new Vector3(x + rand(-1, 1) * scatter, 0, receiverSide * (depth + rand(-1, 1) * scatter));
  return {
    target,
    flightTime: hard ? 1.0 : 1.4,
    spin: topspin(target.clone().sub(from), hard ? 40 : 15),
    clearance: hard ? 0.4 : 1.0,
  };
}
