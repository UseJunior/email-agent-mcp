import { afterEach, expect, it, vi } from 'vitest';
import { _resetConfigForTests } from './config.js';
import { _resetStoreForTests, getStore } from './store.js';

const kv = vi.hoisted(() => ({ eval: vi.fn() }));
vi.mock('@vercel/kv', () => ({ kv }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  _resetConfigForTests();
  _resetStoreForTests();
});

it('uses one EVAL with a raw hex hash and decodes the claim result without a prior GET', async () => {
  vi.stubEnv('GMAIL_OAUTH_CLIENT_ID', 'synthetic');
  vi.stubEnv('GMAIL_OAUTH_CLIENT_SECRET', 'synthetic');
  vi.stubEnv('BROKER_PUBLIC_ORIGIN', 'https://broker.test');
  vi.stubEnv('KV_REST_API_URL', 'https://kv.test');
  const result = { ok: true, tokens: { access_token: 'synthetic', expires_in: 60 } };
  kv.eval.mockResolvedValue(result);
  expect(await getStore().claim('ticket', 'synthetic')).toEqual(result);
  expect(kv.eval).toHaveBeenCalledExactlyOnceWith(expect.any(String), ['session:ticket'], [expect.stringMatching(/^[a-f0-9]{64}$/)]);
});
