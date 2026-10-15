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
export function predictPath(ball: Ball, horizon = 1.8, out: PathSample[] = []): PathSample[] {
  let n = 0;
  if (!ball.inPlay) {
    out.length = 0;
    return out;
  }
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
    // Reuse the sample objects from last time (pass the same array back in) to avoid garbage.
    const s = out[n] ?? (out[n] = { t: 0, x: 0, y: 0, z: 0, bounces: 0, netted: false });
    s.t = i * dt;
    s.x = scratch.pos.x;
    s.y = scratch.pos.y;
    s.z = scratch.pos.z;
    s.bounces = bounces;
    s.netted = netted;
    n++;
  }
  out.length = n;
  return out;
}
