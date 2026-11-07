import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatedAuthManager } from './auth.js';

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock('@azure/identity', () => ({
  useIdentityPlugin: vi.fn(), ClientSecretCredential: vi.fn(),
  DeviceCodeCredential: class { getToken = mocks.getToken; },
}));
vi.mock('@azure/identity-cache-persistence', () => ({ cachePersistencePlugin: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const token = { token: 'synthetic', expiresOnTimestamp: 12345678900000 };
const metadata = {
  clientId: 'synthetic', authenticationRecord: {}, cacheName: 'synthetic',
  lastInteractiveAuthAt: '2026-01-01T00:00:00Z', emailAddress: 'saved@example.test',
};

describe('provider-microsoft/Delegated shared cancellation', () => {
describe.each(['token', 'reconnect'] as const)('operation: %s', operation => {
  let auth: DelegatedAuthManager;
  const call = (signal?: AbortSignal) => operation === 'token' ? auth.getAccessToken(signal) : auth.reconnect(signal);
  beforeEach(() => {
    mocks.getToken.mockReset().mockResolvedValue(token);
    auth = new DelegatedAuthManager({ mode: 'delegated', clientId: 'synthetic' });
    // Inject a synthetic prior session without accessing MSAL or the real filesystem.
    Object.assign(auth, { state: { kind: 'connected', session: {
      credential: { getToken: mocks.getToken }, authRecord: {}, cacheName: 'prior',
      lastInteractiveAuthAt: metadata.lastInteractiveAuthAt, emailAddress: 'prior@example.test', tokenExpiresAt: 100,
    } } });
    vi.spyOn(auth as unknown as { loadMetadata(): Promise<unknown> }, 'loadMetadata').mockResolvedValue(metadata);
  });

  function gate() {
    const started = deferred<AbortSignal>();
    const finish = deferred<typeof token>();
    mocks.getToken.mockImplementationOnce((_scopes, options) => {
      started.resolve(options.abortSignal); return finish.promise;
    });
    return { started, finish };
  }

  it('Scenario: Pre-aborted delegated callers neither start nor join acquisition', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(call(cancelled.signal)).rejects.toBe(cancelled.signal.reason);
    expect(mocks.getToken).not.toHaveBeenCalled();
    const { started, finish } = gate();
    const survivor = call();
    const azure = await started.promise;
    await expect(call(cancelled.signal)).rejects.toBe(cancelled.signal.reason);
    expect(azure.aborted).toBe(false);
    finish.resolve(token);
    await survivor;
    expect(mocks.getToken).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Delegated waiters cancel independently in either ownership order', async () => {
    for (const signalledCreator of [false, true]) {
      const { started, finish } = gate();
      const cancelled = new AbortController();
      const first = call(signalledCreator ? cancelled.signal : undefined);
      const azure = await started.promise;
      const second = call(signalledCreator ? undefined : cancelled.signal);
      const outcome = Promise.allSettled([signalledCreator ? first : second]);
      cancelled.abort();
      await expect(signalledCreator ? first : second).rejects.toBe(cancelled.signal.reason);
      await outcome;
      expect(azure.aborted).toBe(false);
      finish.resolve(token);
      await (signalledCreator ? second : first);
      expect(auth.needsReauth).toBe(false);
    }
  });

  it('Scenario: All delegated waiters cancelling aborts Azure without publishing late results', async () => {
    for (const lateFailure of [false, true]) {
      const { started, finish } = gate();
      const a = new AbortController(); const b = new AbortController();
      const first = call(a.signal); const second = call(b.signal);
      const outcomes = Promise.allSettled([first, second]);
      const azure = await started.promise;
      a.abort(new Error('invalid_grant caller cancellation'));
      expect(azure.aborted).toBe(false);
      b.abort();
      expect(azure.aborted).toBe(true);
      expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
      // A fresh flight must queue behind cleanup, never join cancelled work.
      const fresh = call();
      if (lateFailure) finish.reject(new Error('invalid_grant')); else finish.resolve(token);
      await fresh;
      expect(auth.needsReauth).toBe(false);
      expect(auth.tokenExpiresAt).toBe(token.expiresOnTimestamp);
    }
  });

  it('Scenario: Delegated cancellation drains cooperative Azure work', async () => {
    const started = deferred<AbortSignal>();
    mocks.getToken.mockImplementationOnce((_scopes, options) => new Promise((_resolve, reject) => {
      const signal = options.abortSignal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('invalid_grant after abort')), { once: true });
      started.resolve(signal);
    }));
    const cancelled = new AbortController();
    const pending = call(cancelled.signal);
    const outcome = Promise.allSettled([pending]);
    await started.promise;
    cancelled.abort();
    await outcome;
    // Serialization is the cleanup barrier, including late Azure rejection.
    await (auth as unknown as { mutations: Promise<unknown> }).mutations;
    expect(auth.needsReauth).toBe(false);
    expect(auth.emailAddress).toBe('prior@example.test');
  });

  it('retains the prior session after cancelled late success or terminal failure', async () => {
    for (const lateFailure of [false, true]) {
      const { started, finish } = gate();
      const cancelled = new AbortController();
      const outcome = Promise.allSettled([call(cancelled.signal)]);
      await started.promise;
      cancelled.abort(new Error('invalid_grant cancellation reason'));
      await outcome;
      if (lateFailure) finish.reject(new Error('invalid_grant')); else finish.resolve(token);
      await (auth as unknown as { mutations: Promise<unknown> }).mutations;
      expect(auth.needsReauth).toBe(false);
      expect(auth.emailAddress).toBe('prior@example.test');
      expect(auth.tokenExpiresAt).toBe(100);
    }
  });

  it('removes waiter abort listeners on cancellation and shared settlement', async () => {
    const { started, finish } = gate();
    const a = new AbortController(); const b = new AbortController();
    const removeA = vi.spyOn(a.signal, 'removeEventListener');
    const removeB = vi.spyOn(b.signal, 'removeEventListener');
    const first = call(a.signal); const second = call(b.signal);
    const outcome = Promise.allSettled([first, second]);
    await started.promise;
    a.abort();
    finish.resolve(token);
    await outcome;
    expect(removeA).toHaveBeenCalledTimes(1);
    expect(removeB).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Disconnect aborts shared delegated flights and fences late completion', async () => {
    for (const lateFailure of [false, true]) {
      const { started, finish } = gate();
      const a = new AbortController();
      const pending = call(a.signal);
      const outcome = Promise.allSettled([pending]);
      const azure = await started.promise;
      const disconnected = auth.disconnect();
      expect(azure.aborted).toBe(true);
      const freshReconnect = auth.reconnect();
      const freshToken = auth.getAccessToken();
      expect(auth.getAccessToken()).toBe(freshToken);
      if (lateFailure) finish.reject(new Error('invalid_grant')); else finish.resolve(token);
      expect((await outcome)[0]!.status).toBe('rejected');
      await Promise.all([disconnected, freshReconnect, freshToken]);
      expect(auth.emailAddress).toBe('saved@example.test');
      expect(auth.needsReauth).toBe(false);
    }
  });
});
});
