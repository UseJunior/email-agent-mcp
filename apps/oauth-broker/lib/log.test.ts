import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logEvent,
  redactQuery,
  requestLogContext,
  sessionCorrelationId,
  type BrokerRequestLogFields,
} from './log.js';

const LOG_FIELDS: BrokerRequestLogFields = {
  route: '/api/callback',
  method: 'GET',
  status: 200,
  outcome: 'ready',
  host: 'oauth.usejunior.com',
  ua: 'test-agent',
  sid: 'abcdefgh',
  dur_ms: 7,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('observability/Log Destination', () => {
  it('Scenario: Broker logging is exempt from the stdout prohibition', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logEvent(LOG_FIELDS);

    expect(stdout).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
    const parsed = JSON.parse(String(stdout.mock.calls[0]![0])) as Record<string, unknown>;
    expect(parsed['t']).toBe('broker_request');
  });
});

describe('observability/Broker Request Logging', () => {
  it('strips query strings from URLs before they can be logged', () => {
    expect(redactQuery('https://oauth.usejunior.com/api/callback?code=abc&state=def')).toBe(
      'https://oauth.usejunior.com/api/callback',
    );
    expect(redactQuery('https://oauth.usejunior.com/api/callback')).toBe(
      'https://oauth.usejunior.com/api/callback',
    );
    expect(redactQuery(null)).toBeNull();
  });

  it('emits one valid JSON object with the broker discriminator', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logEvent(LOG_FIELDS);

    expect(stdout).toHaveBeenCalledWith(expect.any(String));
    const raw = String(stdout.mock.calls[0]![0]);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ t: 'broker_request', ...LOG_FIELDS });
  });

  it('normalizes request metadata without copying unrelated headers', () => {
    expect(
      requestLogContext({
        method: 'GET',
        headers: {
          host: ['oauth.usejunior.com', 'ignored.example'],
          'user-agent': ['test-agent', 'ignored-agent'],
        },
      }),
    ).toEqual({
      method: 'GET',
      host: 'oauth.usejunior.com',
      ua: 'test-agent',
    });
    expect(requestLogContext({})).toEqual({ method: '', host: '', ua: '' });
  });

  it('Scenario: Session correlation without exposing the raw id', () => {
    const rawSessionId = 'abcdefghABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789';

    expect(sessionCorrelationId(rawSessionId)).toBe('abcdefgh');
    expect(sessionCorrelationId(rawSessionId)).not.toBe(rawSessionId);
    expect(sessionCorrelationId('short-id')).toBeNull();
    expect(sessionCorrelationId('!'.repeat(40))).toBeNull();
    expect(sessionCorrelationId(undefined)).toBeNull();
  });

  it('never throws, so logging cannot break the OAuth response', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('stdout is gone');
    });
    // A throwing console must not propagate — a dropped log line beats a
    // broken auth response (one-shot ticket loss / 2xx turned into 500).
    expect(() => logEvent(LOG_FIELDS)).not.toThrow();
    spy.mockRestore();
  });
});
