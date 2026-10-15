/**
 * Counters for diagnosing online play. Readable in the browser console as `__kc` (cheap; always on).
 */
export const netStats = {
  frames: 0,
  bgTicks: 0,
  snaps: 0,
  /** Snapshots that moved the ball by more than the smoothing allows (a visible jump). */
  snapJumps: 0,
  /** Snapshots ignored while our own predicted hit was in flight. */
  heldForPrediction: 0,
  /** Sum of how old snapshots were on arrival (s), for an average. */
  ageSum: 0,
  /** Frames where the DRAWN ball jumped more than its speed explains (what players see as glitching). */
  drawnJumps: 0,
  /** Frames with the ball in play (to put drawnJumps in proportion). */
  drawnFrames: 0,
  /** Host messages that arrived and were handled. */
  hostMsgs: 0,
};

if (typeof window !== 'undefined') (window as unknown as { __kc: typeof netStats }).__kc = netStats;
