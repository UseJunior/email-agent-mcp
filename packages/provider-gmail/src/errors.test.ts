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
