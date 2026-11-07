import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, withAuthenticatedRetry, withAutoRefresh, withRetry, type AuthManager, type OperationKind } from '../index.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('provider-interface/Authenticated Retry Safety', () => {
  const auth: AuthManager = {
    connect: vi.fn(), disconnect: vi.fn(), refresh: vi.fn(async () => {}), isTokenExpired: () => true,
  };

  it.each([new Error('timeout'), new ProviderError('INVALID_REQUEST', 'bad request', 'test', false), { status: 503 }])(
    'Scenario: Unrelated failure at expiry is not replayed (%j)', async error => {
      const refresh = vi.fn(async () => {});
      const fn = vi.fn().mockRejectedValue(error);
      await expect(withAutoRefresh({ ...auth, refresh }, fn)).rejects.toBe(error);
      expect(refresh).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['idempotent-read', 'auth-related', 2],
    ['idempotent-write', 'auth-related', 2],
    ['delivery', 'auth-related', 1],
    ['delivery', 'rejected', 2],
    ['idempotent-read', false, 1],
  ] as const)('Scenario: Auth replay gate %s/%s', async (operation, classification, attempts) => {
    const error = new Error('auth failure');
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
    const refresh = vi.fn(async () => true);
    const result = withAuthenticatedRetry(fn, { operation, classifyAuthError: () => classification, refresh });
    if (attempts === 2) await expect(result).resolves.toBe('ok');
    else await expect(result).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(attempts);
    expect(refresh).toHaveBeenCalledTimes(attempts - 1);
  });

  it('Scenario: Compatibility wrapper requires explicit rejection for unspecified operation', async () => {
    const authError = new ProviderError('AUTH_REQUIRED', 'auth required', 'test', false);
    const refresh = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValue(authError);
    await expect(withAutoRefresh({ ...auth, refresh }, fn)).rejects.toBe(authError);
    expect(refresh).not.toHaveBeenCalled();
    const rejected = vi.fn().mockRejectedValueOnce({ status: 401 }).mockResolvedValue('ok');
    await expect(withAutoRefresh({ ...auth, refresh }, rejected)).resolves.toBe('ok');
    expect(rejected).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Recovery is exhausted after one replay and preserves the final error', async () => {
    const original = new Error('first auth');
    const final = new Error('second auth');
    const fn = vi.fn().mockRejectedValueOnce(original).mockRejectedValue(final);
    const refresh = vi.fn(async () => true);
    await expect(withAuthenticatedRetry(fn, { operation: 'delivery', classifyAuthError: () => 'rejected', refresh })).rejects.toBe(final);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Failed recovery preserves rejection without dispatch', async () => {
    const error = new Error('401');
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withAuthenticatedRetry(fn, { operation: 'delivery', classifyAuthError: () => 'rejected', refresh: async () => false })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each(['operation', 'refresh'] as const)('Scenario: Cancellation interrupts %s waiting', async phase => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const pending = () => { entered(); return new Promise<never>(() => {}); };
    const fn = phase === 'operation' ? vi.fn(pending) : vi.fn().mockRejectedValue(new Error('401'));
    const result = withAuthenticatedRetry(fn, {
      operation: 'idempotent-read', classifyAuthError: () => 'rejected',
      refresh: phase === 'refresh' ? pending : vi.fn(async () => true), signal: controller.signal,
    });
    const assertion = expect(result).rejects.toBe(reason);
    await waiting;
    controller.abort(reason);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('provider-interface/Cancellable Retry Backoff', () => {
  it.each(['maxRetries', 'baseDelay', 'maxDelay'] as const)('Scenario: Invalid %s fails before dispatch', async key => {
    for (const value of [-1, NaN, Infinity, -Infinity, ...(key === 'maxRetries' ? [0.5] : [])]) {
      const fn = vi.fn();
      await expect(withRetry(fn, { [key]: value })).rejects.toThrow(RangeError);
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('Scenario: Retry exhaustion preserves the last provider error', async () => {
    const errors = [0, 1, 2].map(i => new ProviderError('PROVIDER_ERROR', String(i), 'test', true));
    const fn = vi.fn().mockRejectedValueOnce(errors[0]).mockRejectedValueOnce(errors[1]).mockRejectedValue(errors[2]);
    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 0 })).rejects.toBe(errors[2]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each(['idempotent-read', 'delivery'] as OperationKind[])('Scenario: Pre-aborted %s never dispatches', async operation => {
    const controller = new AbortController(); controller.abort();
    const fn = vi.fn();
    await expect(withRetry(fn, { signal: controller.signal, operation })).rejects.toBe(controller.signal.reason);
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([1, 3_000_000])('Scenario: Retry-After %s seconds remains a floor and is cancellable', async seconds => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const controller = new AbortController();
    const error = new ProviderError('RATE_LIMITED', 'wait', 'test', true, seconds);
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
    const result = withRetry(fn, { baseDelay: 1000, maxDelay: 1000, signal: controller.signal });
    const assertion = expect(result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(seconds === 1 ? 999 : 2_147_483_648);
    expect(fn).toHaveBeenCalledTimes(1);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Scenario: Server floor above maxDelay eventually permits retry at the floor', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const fn = vi.fn().mockRejectedValueOnce(new ProviderError('RATE_LIMITED', 'wait', 'test', true, 2)).mockResolvedValue('ok');
    const result = withRetry(fn, { baseDelay: 1000, maxDelay: 1000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
  });

  it('Scenario: Long Retry-After survives platform timer chunking', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new ProviderError('RATE_LIMITED', 'wait', 'test', true, 3_000_000)).mockResolvedValue('ok');
    const result = withRetry(fn, { baseDelay: 0, maxDelay: 0 });
    await vi.advanceTimersByTimeAsync(2_999_999_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Ambiguous delivery bypasses generic retries even if marked recoverable', async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError('PROVIDER_ERROR', 'timeout', 'test', true));
    await expect(withRetry(fn, { operation: 'delivery' })).rejects.toThrow('timeout');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
