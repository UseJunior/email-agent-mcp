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

  it('Scenario: Numeric string status is recognized', () => {
    expect(getErrorStatus({ code: '429' })).toBe(429);
  });
});
