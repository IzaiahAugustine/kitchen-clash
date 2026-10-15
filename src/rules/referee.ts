import { COURT, inKitchen, isInCourt, sideOf, type Side } from '../game/court';

export type FaultReason =
  | 'out'
  | 'net'
  | 'kitchen'
  | 'kitchen-momentum'
  | 'two-bounce'
  | 'serve-net'
  | 'serve-kitchen'
  | 'serve-out'
  | 'double-bounce';

export interface Fault {
  /** The side that committed the fault (and loses the rally). */
  side: Side;
  reason: FaultReason;
}

export const FAULT_TEXT: Record<FaultReason, { title: string; detail: string }> = {
  out: { title: 'OUT!', detail: 'Landed outside the court' },
  net: { title: 'NET!', detail: "Didn't make it over the net" },
  kitchen: { title: 'KITCHEN!', detail: 'Volleyed while standing in the kitchen' },
  'kitchen-momentum': { title: 'KITCHEN!', detail: 'Momentum carried into the kitchen after a volley' },
  'two-bounce': { title: 'TWO-BOUNCE RULE!', detail: 'The serve and the return must bounce before anyone volleys' },
  'serve-net': { title: 'SERVE IN THE NET!', detail: "The serve didn't clear the net" },
  'serve-kitchen': { title: 'SHORT SERVE!', detail: 'Serves must clear the kitchen (the kitchen line is short)' },
  'serve-out': { title: 'SERVE OUT!', detail: 'Serves must land in the diagonal service box' },
  'double-bounce': { title: 'MISSED IT!', detail: 'The ball bounced twice' },
};

/** After a volley, stepping into the kitchen within this many seconds still counts as a fault. */
const MOMENTUM_WINDOW = 0.5;

/**
 * Is a bounce inside the receiver's service box? The box runs from the kitchen line (which
 * counts as short) to the baseline, between the centerline and the sideline (both in).
 * @param boxSide +1 / -1: which side of the centerline (x sign) the box is on.
 */
export function inServiceBox(x: number, z: number, receiverSide: Side, boxSide: number): boolean {
  const along = receiverSide * z;
  const across = boxSide * x;
  return (
    along > COURT.kitchenDepth &&
    along <= COURT.halfLength &&
    across >= -COURT.lineWidth / 2 &&
    across <= COURT.halfWidth
  );
}

/** Calls the faults in a rally. Feed it every hit, bounce and net hit. */
export class Referee {
  live = false;
  private hits = 0;
  private hitterSide: Side = 1;
  private bounces = 0;
  private boxSide = 1;
  private volleyAt = -Infinity;
  private volleySide: Side = 1;

  /** Hits so far this rally (1 once the serve is struck). */
  get hitCount(): number {
    return this.hits;
  }

  /** True while the two-bounce rule still applies to the next hit (the return and the third shot). */
  get mustLetBounce(): boolean {
    return this.hits === 1 || this.hits === 2;
  }

  /** Call when the serve is struck. @param boxSide x sign of the target service box */
  startRally(serverSide: Side, boxSide: number): void {
    this.live = true;
    this.hits = 1;
    this.hitterSide = serverSide;
    this.bounces = 0;
    this.boxSide = boxSide;
    this.volleyAt = -Infinity;
  }

  /** A player is hitting the ball (not the serve). Returns a fault if the hit is illegal. */
  onHit(side: Side, bounced: boolean, playerZ: number, time: number): Fault | null {
    if (!this.live) return null;
    const n = this.hits;
    this.hits++;
    this.hitterSide = side;
    this.bounces = 0;
    if (bounced) return null;
    if (n <= 2) return this.end({ side, reason: 'two-bounce' });
    if (inKitchen(playerZ)) return this.end({ side, reason: 'kitchen' });
    this.volleyAt = time;
    this.volleySide = side;
    return null;
  }

  /** Every step: catches players carried into the kitchen right after a volley. */
  watchPlayer(side: Side, z: number, time: number): Fault | null {
    if (!this.live || side !== this.volleySide || time - this.volleyAt > MOMENTUM_WINDOW) return null;
    return inKitchen(z) ? this.end({ side, reason: 'kitchen-momentum' }) : null;
  }

  onBounce(x: number, z: number): Fault | null {
    if (!this.live) return null;
    this.bounces++;
    const landed = sideOf(z);
    const serve = this.hits === 1;
    if (this.bounces === 1) {
      if (landed === this.hitterSide) return this.end({ side: this.hitterSide, reason: serve ? 'serve-net' : 'net' });
      if (serve) {
        if (inServiceBox(x, z, landed, this.boxSide)) return null;
        const short = landed * z <= COURT.kitchenDepth && Math.abs(x) <= COURT.halfWidth && this.boxSide * x >= -COURT.lineWidth / 2;
        return this.end({ side: this.hitterSide, reason: short ? 'serve-kitchen' : 'serve-out' });
      }
      return isInCourt(x, z) ? null : this.end({ side: this.hitterSide, reason: 'out' });
    }
    // Bounced twice without being returned.
    return this.end({ side: landed, reason: 'double-bounce' });
  }

  /** The ball hit the net and stayed on the hitter's side. */
  onNet(): Fault | null {
    if (!this.live) return null;
    return this.end({ side: this.hitterSide, reason: this.hits === 1 ? 'serve-net' : 'net' });
  }

  private end(f: Fault): Fault {
    this.live = false;
    return f;
  }
}
