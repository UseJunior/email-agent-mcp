import { describe, expect, it, vi } from 'vitest';
import { SendRateLimiter } from './send-allowlist.js';
import { adaptLegacyRateLimiter } from './rate-reservation.js';

describe('email-security/Rate Limiting reservations', () => {
  it('Scenario: Capacity barrier includes reservations immediately across actions', async () => {
    const limiter = new SendRateLimiter(2, 1000);
    let open!: () => void;
    const barrier = new Promise<void>(resolve => { open = resolve; });
    const callers = Array.from({ length: 20 }, (_, i) => (async () => {
      await barrier;
      return limiter.tryReserve(i % 2 ? 'send_email' : 'reply_to_email');
    })());
    open();
    const results = await Promise.all(callers);
    expect(results.filter(result => result.allowed)).toHaveLength(2);
    for (const result of results) if (result.allowed) result.lease.release();
    expect(limiter.tryReserve('send_draft').allowed).toBe(true);
  });

  it('Scenario: Empty capacity returns finite retry guidance', () => {
    const limiter = new SendRateLimiter(0, 1000);
    expect(limiter.tryReserve('send_email')).toEqual({ allowed: false, retryAfter: 1 });
  });

  it('Scenario: Terminal accounting is idempotent and live reservations never expire', () => {
    let now = 0;
    const limiter = new SendRateLimiter(1, 1000, () => now);
    const reserved = limiter.tryReserve('send_email');
    if (!reserved.allowed) throw new Error('expected lease');
    now = 10_000;
    expect(limiter.tryReserve('reply_to_email').allowed).toBe(false);
    reserved.lease.consume();
    reserved.lease.consume();
    reserved.lease.release();
    now += 999;
    expect(limiter.tryReserve('send_email')).toEqual({ allowed: false, retryAfter: 1 });
    now++;
    const next = limiter.tryReserve('send_email');
    expect(next.allowed).toBe(true);
    if (!next.allowed) throw new Error('expected lease');
    next.lease.release();
    next.lease.consume();
    next.lease.release();
    expect(limiter.tryReserve('send_email').allowed).toBe(true);
  });

  it('Scenario: Default clock ignores wall-clock jumps', () => {
    const wallClock = vi.spyOn(Date, 'now');
    try {
      const limiter = new SendRateLimiter(1, 60_000);
      const result = limiter.tryReserve('send_email');
      if (!result.allowed) throw new Error('expected lease');
      result.lease.consume();
      wallClock.mockReturnValue(Number.MAX_SAFE_INTEGER);
      expect(limiter.tryReserve('send_email').allowed).toBe(false);
      wallClock.mockReturnValue(0);
      expect(limiter.tryReserve('send_email').allowed).toBe(false);
    } finally { wallClock.mockRestore(); }
  });

  it('Scenario: Legacy adapter preserves check/record but cannot reserve concurrently', () => {
    const recordUsage = vi.fn();
    const adapter = adaptLegacyRateLimiter({ checkLimit: () => ({ allowed: true }), recordUsage });
    const first = adapter.tryReserve('send_email');
    const second = adapter.tryReserve('send_email');
    if (!first.allowed || !second.allowed) throw new Error('legacy checks allow both');
    first.lease.release();
    first.lease.consume();
    second.lease.consume();
    second.lease.consume();
    second.lease.release();
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith('send_email');
  });
});
