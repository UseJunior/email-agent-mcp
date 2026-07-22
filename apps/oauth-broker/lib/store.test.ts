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

describe('provider-gmail/OAuth2 Authentication (broker store)', () => {
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

  it('Scenario: Atomic one-shot ticket claim', async () => {
    // setReady → claim succeeds once and only once — including when two
    // claims race concurrently (claim() awaits a hash computation before
    // deleting the session, so a real interleaving window exists).
    const store = getStore();
    const id = 'c'.repeat(40);
    const secret = 'secret-success';
    await store.create(id, freshSession(secret));
    await store.setReady(id, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
    });

    const [a, b] = await Promise.all([store.claim(id, secret), store.claim(id, secret)]);
    const results = [a, b];
    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (succeeded[0]!.ok) expect(succeeded[0]!.tokens.access_token).toBe('at');
    if (!failed[0]!.ok) expect(['consumed', 'not_found']).toContain(failed[0]!.reason);

    // A third claim after both have resolved must also fail — the session
    // is gone, not merely "in use".
    const c = await store.claim(id, secret);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(['consumed', 'not_found']).toContain(c.reason);
  });

  it('Scenario: Public session_id is not a bearer credential', async () => {
    // A wrong-secret claim attempt (the session_id alone is not enough)
    // must fail without consuming or destroying the session.
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

  it('Scenario: Distinguishable terminal states', async () => {
    // setFailed surfaces denied vs exchange_failed distinctly; sibling
    // tests in this file cover the pending and expired terminal states.
    const store = getStore();
    const deniedId = 'e'.repeat(40);
    const secret = 'sec';
    await store.create(deniedId, freshSession(secret));
    await store.setFailed(deniedId, 'denied', 'user cancelled');

    const deniedResult = await store.claim(deniedId, secret);
    expect(deniedResult.ok).toBe(false);
    if (!deniedResult.ok) {
      expect(deniedResult.reason).toBe('denied');
      expect(deniedResult.errorMessage).toBe('user cancelled');
    }

    const exchangeFailedId = 'a1'.repeat(20);
    await store.create(exchangeFailedId, freshSession(secret));
    await store.setFailed(exchangeFailedId, 'exchange_failed', 'invalid_grant');

    const exchangeFailedResult = await store.claim(exchangeFailedId, secret);
    expect(exchangeFailedResult.ok).toBe(false);
    if (!exchangeFailedResult.ok) {
      expect(exchangeFailedResult.reason).toBe('exchange_failed');
      expect(exchangeFailedResult.errorMessage).toBe('invalid_grant');
    }

    // The two failure modes must be distinguishable from one another, not
    // just each distinguishable from success.
    expect(deniedResult.ok || exchangeFailedResult.ok).toBe(false);
    if (!deniedResult.ok && !exchangeFailedResult.ok) {
      expect(deniedResult.reason).not.toBe(exchangeFailedResult.reason);
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
