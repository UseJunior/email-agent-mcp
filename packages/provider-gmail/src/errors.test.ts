import { describe, expect, it } from 'vitest';
import { gmailProviderError, getErrorStatus } from './errors.js';

describe('provider-gmail/Gmail Error Classification', () => {
  it('Scenario: Gmail 403 quota rejection is rate limited', () => {
    const error = gmailProviderError({
      code: '403',
      response: { data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
    }, 'delivery');

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.recoverable).toBe(false);
  });

  it('Scenario: Gmail 429 is rate limited', () => {
    const error = gmailProviderError({ code: 429, message: 'throttled' }, 'delivery');

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.recoverable).toBe(false);
  });

  it('Scenario: Gmail rate limit retains Retry-After', () => {
    const error = gmailProviderError({
      code: 429,
      response: { headers: { 'retry-after': '45' } },
    }, 'delivery');

    expect(error.retryAfter).toBe(45);
  });

  it('Scenario: Gmail quota rejection retains Retry-After from Headers', () => {
    const error = gmailProviderError({
      code: 403,
      response: {
        headers: new Headers({ 'Retry-After': '30' }),
        data: { error: { errors: [{ reason: 'quotaExceeded' }] } },
      },
    }, 'delivery');

    expect(error.retryAfter).toBe(30);
  });

  it('Scenario: Numeric string status is recognized', () => {
    expect(getErrorStatus({ code: '429' })).toBe(429);
  });
});

describe('provider-gmail/Gmail Transport Classification', () => {
  it('names a delivery whose connection never opened as unreachable, not a generic error', () => {
    // Provably no request bytes were written. The distinction is load-bearing:
    // the duplicate-send guard releases a proven non-delivery and holds an
    // ambiguous one, and it cannot release a generic PROVIDER_ERROR because
    // that code also covers failures that are not proven. Matches what the
    // Graph provider already reports for the same condition.
    const error = gmailProviderError(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      'delivery',
    );

    expect(error.code).toBe('PROVIDER_UNREACHABLE');
    expect(error.recoverable).toBe(false);
  });

  it('still reports an ambiguous delivery transport failure as unknown', () => {
    const error = gmailProviderError(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      'delivery',
    );

    expect(error.code).toBe('SEND_STATUS_UNKNOWN');
  });

  it('leaves non-delivery transport failures on the generic recoverable code', () => {
    const error = gmailProviderError(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      'idempotent-read',
    );

    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.recoverable).toBe(true);
  });
});
