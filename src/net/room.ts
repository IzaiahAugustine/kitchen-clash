import type { DatabaseReference } from 'firebase/database';
import type { Channel } from './channel';
import { getDb } from './firebase';

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
/**
 * If a direct connection isn't up by then, fall back to relaying through Firebase. The host
 * decides (and tells the guest via `mode`), so both ends always use the same kind of channel.
 */
const P2P_TIMEOUT_MS = 7000;
const GUEST_P2P_TIMEOUT_MS = 12000;

export type Role = 'host' | 'guest';

/** A Kitchen Clash online room: a 5-digit code under /kc/rooms in the Realtime Database. */
export class Room {
  private unsubs: (() => void)[] = [];
  private pc: RTCPeerConnection | null = null;
  private closed = false;
  /** Called when the other player leaves or the room disappears. */
  onGone: () => void = () => {};

  private constructor(
    readonly code: string,
    readonly role: Role,
    private fb: typeof import('firebase/database'),
    private root: DatabaseReference,
  ) {}

  /** Creates a room with a fresh code and waits for a guest to join. */
  static async create(name: string): Promise<Room> {
    const fb = await import('firebase/database');
    const db = await getDb();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = String(Math.floor(10000 + Math.random() * 90000));
      const ref = fb.ref(db, `kc/rooms/${code}`);
      const existing = await fb.get(ref);
      if (existing.exists()) continue;
      await fb.set(ref, { created: fb.serverTimestamp(), status: 'waiting', host: { name: name.slice(0, 24) } });
      await fb.onDisconnect(ref).remove();
      return new Room(code, 'host', fb, ref);
    }
    throw new Error("Couldn't create a room. Try again.");
  }

  /** Joins a friend's room by code. */
  static async join(code: string, name: string): Promise<{ room: Room; hostName: string }> {
    const fb = await import('firebase/database');
    const db = await getDb();
    const ref = fb.ref(db, `kc/rooms/${code}`);
    const snap = await fb.get(ref);
    if (!snap.exists()) throw new Error(`No match with code ${code}. Check the code with your friend.`);
    const room = snap.val() as { status: string; host: { name: string }; guest?: unknown };
    if (room.status !== 'waiting' || room.guest) throw new Error('That match has already started.');
    await fb.set(fb.child(ref, 'guest'), { name: name.slice(0, 24) });
    await fb.onDisconnect(fb.child(ref, 'left')).set('guest');
    return { room: new Room(code, 'guest', fb, ref), hostName: room.host.name };
  }

  /** Host: resolves with the guest's name once someone joins. */
  waitForGuest(): Promise<string> {
    return new Promise((resolve) => {
      const off = this.fb.onValue(this.fb.child(this.root, 'guest'), (s) => {
        if (s.exists()) {
          off();
          resolve((s.val() as { name: string }).name);
        }
      });
      this.unsubs.push(off);
    });
  }

  /** Opens the game channel: direct (WebRTC) if possible, otherwise relayed through Firebase. */
  async connect(): Promise<Channel> {
    const fb = this.fb;
    this.unsubs.push(
      fb.onValue(fb.child(this.root, 'left'), (s) => s.exists() && this.gone()),
      fb.onValue(this.root, (s) => !s.exists() && this.gone()),
    );
    if (this.role === 'host') await fb.set(fb.child(this.root, 'status'), 'playing');
    try {
      if (typeof RTCPeerConnection === 'undefined') throw new Error('no WebRTC');
      // Test hook: `?relay` skips the direct connection.
      if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('relay')) throw new Error('relay forced');
      const channel = await this.connectP2P();
      console.info('[KC] direct connection');
      return channel;
    } catch (err) {
      console.info(`[KC] using relay (${err instanceof Error ? err.message : err})`);
      // Tell the other side to switch too (it may still be waiting on the direct connection).
      await fb.set(fb.child(this.root, `mode/${this.role}`), 'relay').catch(() => {});
      return this.connectRelay();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const u of this.unsubs) u();
    this.pc?.close();
    if (this.role === 'host') void this.fb.remove(this.root);
    else void this.fb.set(this.fb.child(this.root, 'left'), 'guest').catch(() => {});
  }

  private gone(): void {
    if (this.closed) return;
    this.close();
    this.onGone();
  }

  // ---------------------------------------------------------------- direct (WebRTC)

  private connectP2P(): Promise<Channel> {
    const fb = this.fb;
    const sig = fb.child(this.root, 'signal');
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    const mine = this.role === 'host' ? 'hostIce' : 'guestIce';
    const theirs = this.role === 'host' ? 'guestIce' : 'hostIce';
    pc.onicecandidate = (e) => {
      if (e.candidate) void fb.push(fb.child(sig, mine), JSON.stringify(e.candidate));
    };
    // Candidates can arrive before the remote description; hold them until it's set.
    const pending: RTCIceCandidateInit[] = [];
    let remoteSet = false;
    const addIce = (c: RTCIceCandidateInit) => (remoteSet ? void pc.addIceCandidate(c).catch(() => {}) : pending.push(c));
    const setRemote = async (d: RTCSessionDescriptionInit) => {
      await pc.setRemoteDescription(d);
      remoteSet = true;
      for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    };
    this.unsubs.push(fb.onChildAdded(fb.child(sig, theirs), (s) => addIce(JSON.parse(s.val() as string))));

    return new Promise<Channel>((resolve, reject) => {
      const channels: Record<string, RTCDataChannel> = {};
      // Messages can arrive before both channels are open here (the other side may be ready
      // first): keep them for the channel instead of dropping them.
      const early: Record<string, unknown>[] = [];
      let done = false;
      const fail = (why: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('p2p timeout'), this.role === 'host' ? P2P_TIMEOUT_MS : GUEST_P2P_TIMEOUT_MS);
      // The other side gave up on the direct connection: follow it to the relay.
      const other = this.role === 'host' ? 'guest' : 'host';
      this.unsubs.push(fb.onValue(fb.child(this.root, `mode/${other}`), (s) => s.exists() && fail('other side chose relay')));
      const ready = () => {
        if (!done && channels.ev?.readyState === 'open' && channels.st?.readyState === 'open') {
          done = true;
          clearTimeout(timer);
          resolve(new P2PChannel(channels.ev, channels.st, early));
        }
      };
      const track = (c: RTCDataChannel) => {
        channels[c.label] = c;
        c.onmessage = (e) => early.push(JSON.parse(e.data as string));
        c.onopen = ready;
        ready();
      };
      if (this.role === 'host') {
        track(pc.createDataChannel('ev', { ordered: true }));
        track(pc.createDataChannel('st', { ordered: false, maxRetransmits: 0 }));
        void (async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await fb.set(fb.child(sig, 'offer'), JSON.stringify(offer));
        })();
        this.unsubs.push(
          fb.onValue(fb.child(sig, 'answer'), (s) => {
            if (s.exists() && !remoteSet) void setRemote(JSON.parse(s.val() as string));
          }),
        );
      } else {
        pc.ondatachannel = (e) => track(e.channel);
        this.unsubs.push(
          fb.onValue(fb.child(sig, 'offer'), (s) => {
            if (!s.exists() || remoteSet) return;
            void (async () => {
              await setRemote(JSON.parse(s.val() as string));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await fb.set(fb.child(sig, 'answer'), JSON.stringify(answer));
            })();
          }),
        );
      }
    }).catch(async (err) => {
      pc.close();
      this.pc = null;
      throw err;
    });
  }

  // ---------------------------------------------------------------- relayed (Firebase)

  private connectRelay(): Channel {
    const fb = this.fb;
    const out = fb.child(this.root, `relay/${this.role === 'host' ? 'toGuest' : 'toHost'}`);
    const inbox = fb.child(this.root, `relay/${this.role === 'host' ? 'toHost' : 'toGuest'}`);
    const channel = new RelayChannel((msg) => void fb.push(out, { m: JSON.stringify(msg) }));
    // Only the ones that arrive from now on: anything from the abandoned direct attempt is stale.
    this.unsubs.push(
      fb.onChildAdded(inbox, (s) => {
        void fb.remove(s.ref);
        channel.receive(JSON.parse((s.val() as { m: string }).m));
      }),
    );
    return channel;
  }
}

/**
 * Holds incoming messages until the game attaches its handler, so nothing sent in the first
 * moments of a connection (like the guest's 'ready') is lost.
 */
class Inbox {
  private handler: ((msg: Record<string, unknown>) => void) | null = null;
  private queue: Record<string, unknown>[] = [];

  get onMessage(): (msg: Record<string, unknown>) => void {
    return (m) => this.receive(m);
  }

  set onMessage(h: (msg: Record<string, unknown>) => void) {
    this.handler = h;
    for (const m of this.queue.splice(0)) h(m);
  }

  receive(m: Record<string, unknown>): void {
    if (this.handler) this.handler(m);
    else this.queue.push(m);
  }
}

class P2PChannel extends Inbox implements Channel {
  readonly kind = 'p2p' as const;
  onClose: () => void = () => {};

  constructor(
    private ev: RTCDataChannel,
    private st: RTCDataChannel,
    early: Record<string, unknown>[],
  ) {
    super();
    for (const m of early) this.receive(m);
    const recv = (e: MessageEvent) => this.receive(JSON.parse(e.data as string));
    ev.onmessage = recv;
    st.onmessage = recv;
    ev.onclose = () => this.onClose();
  }

  send(msg: object, reliable = true): void {
    const c = reliable ? this.ev : this.st;
    if (c.readyState === 'open') c.send(JSON.stringify(msg));
  }

  close(): void {
    this.ev.close();
    this.st.close();
  }
}

class RelayChannel extends Inbox implements Channel {
  readonly kind = 'relay' as const;
  onClose: () => void = () => {};
  constructor(private write: (msg: object) => void) {
    super();
  }
  send(msg: object): void {
    this.write(msg);
  }
  close(): void {
    this.onClose();
  }
}
