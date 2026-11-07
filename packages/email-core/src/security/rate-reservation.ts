import type { RateLimiter, RateReservation, ReservationRateLimiter } from '../actions/registry.js';

/** @deprecated Legacy check/record cannot reserve capacity across concurrent callers.
 * This adapter preserves injected providers, but cannot make their protocol atomic.
 */
export function adaptLegacyRateLimiter(legacy: RateLimiter): ReservationRateLimiter {
  return {
    tryReserve(action) {
      const result = legacy.checkLimit(action);
      if (!result.allowed) return { allowed: false, ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}) };
      return { allowed: true, lease: terminalRateReservation(() => {}, () => legacy.recordUsage(action)) };
    },
  };
}

/** Set terminal state before invoking bookkeeping, including when it throws. */
export function terminalRateReservation(release: () => void, consume: () => void): RateReservation {
  let terminal = false;
  const finish = (callback: () => void) => {
    if (terminal) return;
    terminal = true;
    callback();
  };
  return { release: () => finish(release), consume: () => finish(consume) };
}
