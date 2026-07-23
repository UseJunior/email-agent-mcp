import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetConfigForTests, getConfig } from './config.js';

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const baseEnv = {
  GMAIL_OAUTH_CLIENT_ID: 'fake-client',
  GMAIL_OAUTH_CLIENT_SECRET: 'fake-secret',
  BROKER_PUBLIC_ORIGIN: 'https://broker.test',
  KV_REST_API_URL: undefined,
  BROKER_REQUIRE_KV: undefined,
  VERCEL_ENV: undefined,
};

beforeEach(() => {
  setEnv(baseEnv);
  _resetConfigForTests();
});

afterEach(() => {
  for (const k of Object.keys(baseEnv)) delete process.env[k];
  delete process.env['VERCEL_ENV'];
  _resetConfigForTests();
});

describe('provider-gmail/OAuth2 Authentication (broker config)', () => {
  it('defaults to the narrow Gmail modify scope', () => {
    expect(getConfig().scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
  });

  it('Scenario: Broker requires Redis in production', () => {
    // VERCEL_ENV=production with no KV_REST_API_URL must fail fast rather
    // than silently falling back to in-memory state that is not shared
    // across function invocations.
    setEnv({ VERCEL_ENV: 'production' });

    expect(() => getConfig()).toThrow(/require.*Redis|KV_REST_API_URL/i);
  });

  it('BROKER_REQUIRE_KV=true forces the same failure outside production', () => {
    setEnv({ BROKER_REQUIRE_KV: 'true' });

    expect(() => getConfig()).toThrow(/require.*Redis|KV_REST_API_URL/i);
  });

  it('BROKER_REQUIRE_KV=false opts out even in production', () => {
    setEnv({ VERCEL_ENV: 'production', BROKER_REQUIRE_KV: 'false' });

    expect(() => getConfig()).not.toThrow();
  });

  it('production with KV_REST_API_URL set does not throw', () => {
    setEnv({ VERCEL_ENV: 'production', KV_REST_API_URL: 'https://kv.example.com' });

    expect(() => getConfig()).not.toThrow();
    expect(getConfig().useKv).toBe(true);
  });
});
