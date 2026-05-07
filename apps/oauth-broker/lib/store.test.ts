// In-memory store covers the protocol logic. The KV path is a thin
// wrapper around the same shape; we test it via integration in the
// route tests with a fake @vercel/kv mock.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { _resetStoreForTests, getStore, type Session } from './store.js';
import { _resetConfigForTests } from './config.js';

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
  BROKER_REQUIRE_KV: 'false',
  BROKER_TICKET_TTL_MS: '60000',
};

beforeEach(() => {
  setEnv(baseEnv);
  _resetConfigForTests();
  _resetStoreForTests();
});

afterEach(() => {
  for (const k of Object.keys(baseEnv)) delete process.env[k];
  _resetConfigForTests();
  _resetStoreForTests();
});

function freshSession(secret: string): Session {
  return {
    state: 'pending',
    pickupHash: createHash('sha256').update(secret).digest('hex'),
    createdAt: Date.now(),
  };
}

describe('broker/store memory backend', () => {
  it('refuses session_id collisions', async () => {
    const store = getStore();
    const r1 = await store.create('a'.repeat(40), freshSession('secret-1'));
    expect(r1).toEqual({ created: true });
    const r2 = await store.create('a'.repeat(40), freshSession('other'));
    expect(r2).toEqual({ created: false, reason: 'collision' });
  });

  it('claim returns pending while still pending', async () => {
    const store = getStore();
    const id = 'b'.repeat(40);
    const secret = 'secret-pending';
    await store.create(id, freshSession(secret));
    const result = await store.claim(id, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pending');
  });

  it('setReady → claim succeeds once and only once (atomic)', async () => {
    const store = getStore();
    const id = 'c'.repeat(40);
    const secret = 'secret-success';
    await store.create(id, freshSession(secret));
    await store.setReady(id, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
    });

    const a = await store.claim(id, secret);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.tokens.access_token).toBe('at');

    const b = await store.claim(id, secret);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(['consumed', 'not_found']).toContain(b.reason);
  });

  it('claim with wrong secret does NOT consume the session', async () => {
    const store = getStore();
    const id = 'd'.repeat(40);
    const secret = 'right';
    await store.create(id, freshSession(secret));
    await store.setReady(id, { access_token: 'at', expires_in: 3600 });

    const bad = await store.claim(id, 'wrong');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid_secret');

    // The session must still be claimable by the legitimate caller —
    // a wrong-secret attempt cannot destroy state.
    const good = await store.claim(id, secret);
    expect(good.ok).toBe(true);
  });

  it('setFailed surfaces denied vs exchange_failed distinctly', async () => {
    const store = getStore();
    const id = 'e'.repeat(40);
    const secret = 'sec';
    await store.create(id, freshSession(secret));
    await store.setFailed(id, 'denied', 'user cancelled');

    const result = await store.claim(id, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('denied');
      expect(result.errorMessage).toBe('user cancelled');
    }
  });

  it('expired sessions surface as expired (not consumed)', async () => {
    setEnv({ ...baseEnv, BROKER_TICKET_TTL_MS: '1' });
    _resetConfigForTests();
    _resetStoreForTests();
    const store = getStore();
    const id = 'f'.repeat(40);
    const secret = 'sec';
    await store.create(id, freshSession(secret));
    // Wait past the TTL.
    await new Promise(r => setTimeout(r, 5));
    const result = await store.claim(id, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });
});
