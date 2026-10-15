import { Ball } from './ball';
import { PHYS } from './constants';

export interface PathSample {
  /** Seconds from now. */
  t: number;
  x: number;
  y: number;
  z: number;
  /** Bounces between now and this sample. */
  bounces: number;
  /** The ball has run into the net by this sample. */
  netted: boolean;
}

const scratch = new Ball();

/**
 * Runs the real ball physics forward (bounces and net included) so players and the AI can
 * see where the ball will be. Uses the same fixed step as the game, so it matches exactly.
 */
export function predictPath(ball: Ball, horizon = 1.8): PathSample[] {
  const out: PathSample[] = [];
  if (!ball.inPlay) return out;
  scratch.launch(ball.pos, ball.vel, ball.spin);
  scratch.rolling = ball.rolling;
  let bounces = 0;
  let netted = false;
  const dt = PHYS.fixedDt;
  const steps = Math.ceil(horizon / dt);
  for (let i = 1; i <= steps && scratch.inPlay; i++) {
    scratch.step(dt);
    for (const e of scratch.drainEvents()) {
      if (e.type === 'bounce') bounces++;
      else if (e.type === 'net') netted = true;
    }
    out.push({ t: i * dt, x: scratch.pos.x, y: scratch.pos.y, z: scratch.pos.z, bounces, netted });
  }
  return out;
}
