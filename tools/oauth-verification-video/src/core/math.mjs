export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

export function easeOutCubic(value) {
  const t = clamp(value);
  return 1 - ((1 - t) ** 3);
}

export function easeInOutCubic(value) {
  const t = clamp(value);
  return t < 0.5
    ? 4 * t * t * t
    : 1 - ((-2 * t + 2) ** 3) / 2;
}

export function windowedProgress(localMs, startMs, durationMs) {
  return clamp((localMs - startMs) / durationMs);
}
