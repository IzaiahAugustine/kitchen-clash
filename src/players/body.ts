/**
 * Body measurements of the Blender player model (tools/blender/build_player.py), in feet,
 * plus the geometry of where the ball sits relative to the body at contact.
 */
export const BODY = {
  hipsY: 3.05,
  shoulderX: 0.6,
  shoulderY: 4.65,
  thigh: 1.35,
  shin: 1.45,
  /** Head center height when standing (for looking at the ball). */
  headY: 5.3,
  /** Shoulder to the paddle's sweet spot with a nearly straight arm. */
  armReach: 2.55,
  /** Contact happens this far in front of the body. */
  contactForward: 1.0,
} as const;

export type Hand = 'fore' | 'back';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Hip and knee bend for a crouch amount (0 = standing tall, 1 = deep squat), and how far the hips drop. */
export function legPose(crouch: number): { hip: number; knee: number; drop: number } {
  const hip = crouch * 1.3;
  const knee = -crouch * 2.2;
  const drop = BODY.thigh * (1 - Math.cos(hip)) + BODY.shin * (1 - Math.cos(hip + knee));
  return { hip, knee, drop };
}

/** Low balls need a deeper crouch. */
export function crouchForHeight(height: number): number {
  return clamp((3.8 - height) / 2.6, 0.08, 0.9);
}

/**
 * Where the ball should be relative to the player's feet at contact, in player-local terms:
 * `lateral` is to the player's right (negative = left), `forward` is toward the net.
 */
export function strikeGeometry(height: number, hand: Hand): { lateral: number; forward: number; crouch: number } {
  const crouch = crouchForHeight(height);
  const dy = BODY.shoulderY - legPose(crouch).drop - height;
  const fwd = BODY.contactForward;
  const h = Math.sqrt(Math.max(0, BODY.armReach ** 2 - dy * dy - fwd * fwd));
  const lateral = hand === 'fore' ? BODY.shoulderX + Math.max(h, 0.5) : BODY.shoulderX - Math.max(h, 1.3);
  return { lateral, forward: fwd, crouch };
}
