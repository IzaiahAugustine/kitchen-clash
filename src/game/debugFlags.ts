/** Reads a debug URL parameter (`?lab`, `?autoplay`, `?warp=6`...). Safe outside the browser. */
export function debugFlag(name: string): string | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get(name);
}

export function hasDebugFlag(name: string): boolean {
  return debugFlag(name) !== null;
}
