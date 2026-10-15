/** A two-way message pipe between the host and the guest. */
export interface Channel {
  /** 'p2p' = direct WebRTC, 'relay' = through Firebase (slower), 'loopback' = tests. */
  readonly kind: 'p2p' | 'relay' | 'loopback';
  /**
   * @param reliable true for events that must arrive (presses, scores); false for frequent
   *   state that's fine to drop (positions, snapshots)
   */
  send(msg: object, reliable?: boolean): void;
  onMessage: (msg: Record<string, unknown>) => void;
  onClose: () => void;
  close(): void;
}

/**
 * In-memory pair of channels with artificial latency, for headless tests of the online code.
 * Messages are delivered when `pump(now)` is called with a time past their arrival.
 */
export function loopbackPair(latencyMs: number): [LoopbackChannel, LoopbackChannel, (now: number) => void] {
  const a = new LoopbackChannel();
  const b = new LoopbackChannel();
  const queue: { at: number; to: LoopbackChannel; msg: object }[] = [];
  let clock = 0;
  a.deliver = (msg) => queue.push({ at: clock + latencyMs, to: b, msg: JSON.parse(JSON.stringify(msg)) });
  b.deliver = (msg) => queue.push({ at: clock + latencyMs, to: a, msg: JSON.parse(JSON.stringify(msg)) });
  const pump = (now: number) => {
    clock = now;
    queue.sort((x, y) => x.at - y.at);
    while (queue.length && queue[0].at <= now) {
      const m = queue.shift()!;
      m.to.onMessage(m.msg as Record<string, unknown>);
    }
  };
  return [a, b, pump];
}

export class LoopbackChannel implements Channel {
  readonly kind = 'loopback' as const;
  deliver: (msg: object) => void = () => {};
  onMessage: (msg: Record<string, unknown>) => void = () => {};
  onClose: () => void = () => {};
  send(msg: object): void {
    this.deliver(msg);
  }
  close(): void {
    this.onClose();
  }
}
