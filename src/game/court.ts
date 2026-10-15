/**
 * Court geometry in feet. World axes: x = across the court (right is +x from the near
 * baseline), y = up, z = along the court. The net is at z = 0, the near (camera / human)
 * side is +z and the far side is -z.
 *
 * Keep in sync with tools/blender/build_court.py.
 */
export const COURT = {
  width: 20,
  length: 44,
  halfWidth: 10,
  halfLength: 22,
  /** Non-volley zone ("kitchen") depth from the net, line included. */
  kitchenDepth: 7,
  lineWidth: 2 / 12,
  /** Net posts are 22 ft apart, 1 ft outside each sideline. */
  netPostX: 11,
  netHeightCenter: 34 / 12,
  netHeightPost: 36 / 12,
} as const;

/** Height of the top of the net at a given x (it sags from 36" at the posts to 34" in the middle). */
export function netHeightAt(x: number): number {
  const t = Math.min(Math.abs(x) / COURT.netPostX, 1);
  return COURT.netHeightCenter + (COURT.netHeightPost - COURT.netHeightCenter) * t * t;
}

/** Lines are in: a ball touching any boundary line counts as in. */
export function isInCourt(x: number, z: number): boolean {
  return Math.abs(x) <= COURT.halfWidth && Math.abs(z) <= COURT.halfLength;
}

/** 1 for the near (+z) half, -1 for the far (-z) half. */
export type Side = 1 | -1;

export function sideOf(z: number): Side {
  return z >= 0 ? 1 : -1;
}

/** How far a player's feet reach from their center (touching the kitchen line counts as in). */
export const FOOT_REACH = 0.3;

/** Is a player standing at this z in (or on the line of) a kitchen? */
export function inKitchen(z: number): boolean {
  return Math.abs(z) <= COURT.kitchenDepth + FOOT_REACH;
}
