import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests } from './config.js';
import { _resetStoreForTests, getStore, type Session } from './store.js';

const fakeKv = vi.hoisted(() => {
  const values = new Map<string, unknown>();

  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    }),
    set: vi.fn(async (key: string, value: unknown, options?: { nx?: boolean }) => {
      if (options?.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
  };
});

vi.mock('@vercel/kv', () => ({ kv: fakeKv }));

const baseEnv = {
  GMAIL_OAUTH_CLIENT_ID: 'fake-client',
  GMAIL_OAUTH_CLIENT_SECRET: 'fake-secret',
  BROKER_PUBLIC_ORIGIN: 'https://broker.test',
  KV_REST_API_URL: 'https://kv.test',
  BROKER_REQUIRE_KV: 'true',
  BROKER_TICKET_TTL_MS: '60000',
};

function setEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function freshSession(secret: string): Session {
  return {
    state: 'pending',
    pickupHash: createHash('sha256').update(secret).digest('hex'),
    createdAt: Date.now(),
  };
}

beforeEach(() => {
  setEnv(baseEnv);
  fakeKv.values.clear();
  vi.clearAllMocks();
  _resetConfigForTests();
  _resetStoreForTests();
});

afterEach(() => {
  for (const key of Object.keys(baseEnv)) delete process.env[key];
  fakeKv.values.clear();
  _resetConfigForTests();
  _resetStoreForTests();
});

describe('provider-gmail/OAuth2 Authentication (KV broker store)', () => {
  it('Scenario: Atomic one-shot ticket claim via Redis GETDEL', async () => {
    const store = getStore();
    const id = 'a'.repeat(40);
    const secret = 'secret-success';
    await store.create(id, freshSession(secret));
    await store.setReady(id, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
    });

    const results = await Promise.all([
      store.claim(id, secret),
      store.claim(id, secret),
    ]);

    const succeeded = results.filter(result => result.ok);
    const failed = results.filter(result => !result.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (succeeded[0]?.ok) expect(succeeded[0].tokens.access_token).toBe('at');
    if (failed[0] && !failed[0].ok) expect(failed[0].reason).toBe('consumed');

    expect(fakeKv.getdel).toHaveBeenCalledTimes(2);
    expect(fakeKv.getdel).toHaveBeenCalledWith(`session:${id}`);
    expect(await store.get(id)).toBeNull();
  });

  it('does not call GETDEL or consume a ticket when the secret is invalid', async () => {
    const store = getStore();
    const id = 'b'.repeat(40);
    const secret = 'right-secret';
    await store.create(id, freshSession(secret));
    await store.setReady(id, { access_token: 'at', expires_in: 3600 });

    const rejected = await store.claim(id, 'wrong-secret');
    expect(rejected).toEqual({ ok: false, reason: 'invalid_secret' });
    expect(fakeKv.getdel).not.toHaveBeenCalled();

    const claimed = await store.claim(id, secret);
    expect(claimed.ok).toBe(true);
    expect(fakeKv.getdel).toHaveBeenCalledTimes(1);
  });
});
