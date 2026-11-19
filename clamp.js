export function clamp(n, lo, hi) {
  if (lo > hi) [lo, hi] = [hi, lo]
  return Math.min(hi, Math.max(lo, n))
}
