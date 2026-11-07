import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests } from './config.js';
import { _resetStoreForTests, getStore } from './store.js';
import { pending, secret, sessionContract, tokens } from './store.contract.js';
import { redisTestServer } from './redis-test-server.js';

describe.skipIf(process.env.BROKER_REDIS_INTEGRATION !== '1')('disposable real Redis via @vercel/kv', () => {
  let redis: Awaited<ReturnType<typeof redisTestServer>>;
  beforeAll(async () => { redis = await redisTestServer(); });
  afterAll(async () => { await redis?.stop(); });
  beforeEach(async () => {
    // The bridge namespaces all session keys per run and removes only those
    // keys on completion. CI supplies an ephemeral service.
    vi.stubEnv('GMAIL_OAUTH_CLIENT_ID', 'synthetic');
    vi.stubEnv('GMAIL_OAUTH_CLIENT_SECRET', 'synthetic');
    vi.stubEnv('BROKER_PUBLIC_ORIGIN', 'https://broker.test');
    vi.stubEnv('KV_REST_API_URL', redis.url);
    vi.stubEnv('KV_REST_API_TOKEN', 'synthetic-local-only');
    vi.stubEnv('BROKER_REQUIRE_KV', 'true');
    vi.stubEnv('BROKER_TICKET_TTL_MS', '60000');
    _resetConfigForTests();
    _resetStoreForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    _resetConfigForTests();
    _resetStoreForTests();
  });

  sessionContract();

  it.each(['ready', 'denied', 'exchange_failed'] as const)('preserves exact Redis expiry for %s and cannot revive expired records', async state => {
    const store = getStore();
    const id = `ttl-${state}`;
    await store.create(id, pending());
    await redis.command(['PEXPIRE', `session:${id}`, 3000]);
    const expiry = await redis.command(['PEXPIRETIME', `session:${id}`]);
    expect(state === 'ready' ? await store.setReady(id, tokens) : await store.setFailed(id, state, 'synthetic')).toBe(true);
    expect(await redis.command(['PEXPIRETIME', `session:${id}`])).toBe(expiry);
    expect(await store.setReady(id, tokens)).toBe(false);
    expect(await redis.command(['PEXPIRETIME', `session:${id}`])).toBe(expiry);
    await redis.command(['PEXPIREAT', `session:${id}`, 1]);
    expect(await store.setReady(id, tokens)).toBe(false);
    expect(await store.setFailed(id, 'denied', 'late')).toBe(false);
    expect(await store.claim(id, secret)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('uses millisecond TTL without rounding up', async () => {
    const store = getStore();
    const before = Date.now();
    await store.create('precision', pending());
    const expiry = await redis.command(['PEXPIRETIME', 'session:precision']) as number;
    expect(expiry).toBeGreaterThanOrEqual(before + 60000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 60000);
  });

  it('rejects invalid JSON without releasing tokens or overwriting it', async () => {
    const store = getStore();
    await redis.command(['SET', 'session:bad-json', '{not json', 'PX', 60000]);
    expect(await store.setReady('bad-json', tokens)).toBe(false);
    expect(await store.claim('bad-json', secret)).toEqual({ ok: false, reason: 'consumed' });
    expect(await redis.command(['GET', 'session:bad-json'])).toBe('{not json');
  });

  it('verifies the replacement record, rather than a snapshot taken before hashing', async () => {
    const store = getStore();
    await store.create('replacement', pending());
    await store.setReady('replacement', tokens);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const hashing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      entered();
      await barrier;
      return digest(...args);
    });
    const claim = store.claim('replacement', secret);
    await hashing;
    const replacement = { ...pending(), state: 'ready', tokens: { ...tokens, access_token: 'replacement' }, pickupHash: '0'.repeat(64) };
    await redis.command(['SET', 'session:replacement', JSON.stringify(replacement), 'PX', 60000]);
    release();
    expect(await claim).toEqual({ ok: false, reason: 'invalid_secret' });
    expect(await store.get('replacement')).toEqual(replacement);
  });
});
