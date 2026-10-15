/** Ball physics tuning. Units: feet, seconds, radians. */
export const PHYS = {
  gravity: 32.17,
  /** 2.9" diameter outdoor ball. */
  ballRadius: 2.9 / 24,
  /** Quadratic air drag coefficient (accel = drag * |v| * v). The holes make pickleballs draggy. */
  drag: 0.0095,
  /** Magnus lift coefficient (accel = magnus * spin × v). Topspin dips, backspin floats. */
  magnus: 0.0022,
  /** Fraction of spin lost per second in flight. */
  spinDecay: 0.35,
  /** Bounce restitution at low impact speed; drops a little for hard impacts. */
  restitution: 0.75,
  restitutionSpeedLoss: 0.0035,
  minRestitution: 0.5,
  /** Court friction coefficient during a bounce (converts slip into spin / speed change). */
  friction: 0.32,
  /** Below this upward speed after a bounce the ball just rolls. */
  rollThreshold: 1.2,
  /** Rolling deceleration (ft/s²). */
  rollFriction: 5,
  /** How much of the ball's speed survives running into the net. */
  netDamping: 0.12,
  /** Fixed simulation step. */
  fixedDt: 1 / 240,
} as const;
