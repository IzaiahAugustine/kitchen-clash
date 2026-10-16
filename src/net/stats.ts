/**
 * Counters for diagnosing online play. Readable in the browser console as `__kc` (cheap; always on).
 */
export const netStats = {
  /** This computer's frame rate, measured each second. */
  fps: 60,
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

declare const __BUILD__: string;
/** Build stamp (month-day hour:minute UTC) of the running game. */
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

/** One line for the online info panel: frame rates on both computers, ping and version. */
export function healthLine(pingMs: number | null, friendFps: number | null): string {
  const bad = (fps: number) => (fps < 40 ? ' class="bad"' : '');
  const me = Math.round(netStats.fps);
  const friend = friendFps === null ? '…' : `<span${bad(friendFps)}>${Math.round(friendFps)}</span>`;
  const ping = pingMs === null ? '…' : `<span${pingMs > 120 ? ' class="bad"' : ''}>${Math.round(pingMs)} ms</span>`;
  return `<div class="dim">Ping ${ping} · Your FPS <span${bad(me)}>${me}</span> · Friend FPS ${friend} · v${BUILD}</div>`;
}
