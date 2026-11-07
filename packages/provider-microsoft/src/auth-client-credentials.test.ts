import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCredentialsAuthManager, type MicrosoftAuthConfig } from './auth.js';

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), construct: vi.fn() }));
vi.mock('@azure/identity', () => ({
  useIdentityPlugin: vi.fn(), DeviceCodeCredential: vi.fn(),
  ClientSecretCredential: class {
    constructor(...args: unknown[]) { mocks.construct(...args); }
    getToken = mocks.getToken;
  },
}));
vi.mock('@azure/identity-cache-persistence', () => ({ cachePersistencePlugin: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const token = { token: 'synthetic-token', expiresOnTimestamp: 12345678900000 };
const replacement = { token: 'replacement-token', expiresOnTimestamp: 12345678910000 };

describe('provider-microsoft/Client Credentials Authentication', () => {
  let auth: ClientCredentialsAuthManager;
  let config: MicrosoftAuthConfig;
  beforeEach(() => {
    mocks.getToken.mockReset().mockResolvedValue(token);
    mocks.construct.mockReset();
    config = { mode: 'client_credentials', clientId: 'synthetic-client', tenantId: 'synthetic-tenant', clientSecret: 'synthetic-secret' };
    auth = new ClientCredentialsAuthManager(config);
  });

  // Inspect lifecycle invariants without adding a public status API.
  function state() {
    return (auth as unknown as { state: { kind: string; session?: { accessToken: string; expiresAt: number } } }).state;
  }
  function barrier() {
    const started = deferred<void>();
    const finish = deferred<typeof token | null>();
    mocks.getToken.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    return { started, finish };
  }

  it('preserves the disconnected legacy token interface and coherent missing configuration', async () => {
    expect(await auth.getAccessToken()).toBeUndefined();
    await expect(auth.refresh()).rejects.toThrow('Not connected');
    for (const field of ['clientId', 'tenantId', 'clientSecret'] as const) {
      const missing = { ...config, [field]: '' };
      auth = new ClientCredentialsAuthManager(missing);
      await expect(auth.connect({})).rejects.toThrow('Client credentials require');
      expect(state().kind).toBe('reauth_required');
      expect(state().session).toBeNull();
      expect(auth.isTokenExpired()).toBe(true);
      expect(await auth.getAccessToken()).toBeUndefined();
      await expect(auth.refresh()).rejects.toThrow('Not connected');
    }
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it('does not retain a usable prior token when required configuration disappears', async () => {
    await auth.connect({});
    config.clientSecret = '';
    await expect(auth.connect({})).rejects.toThrow('Client credentials require');
    expect(state().kind).toBe('reauth_required');
    expect(state().session).toBeNull();
    expect(await auth.getAccessToken()).toBeUndefined();
    config.clientSecret = 'replacement-secret';
    await auth.connect({});
    expect(await auth.getAccessToken()).toBe(token.token);
  });

  it('handles constructor and initial terminal acquisition failures without partial credentials', async () => {
    mocks.construct.mockImplementationOnce(() => { throw new Error('invalid_client'); });
    await expect(auth.connect({})).rejects.toThrow('invalid_client');
    expect(state().kind).toBe('reauth_required');
    expect(state().session).toBeNull();
    expect(await auth.getAccessToken()).toBeUndefined();
    mocks.getToken.mockRejectedValueOnce(new Error('network timeout'));
    await expect(auth.connect({})).rejects.toThrow('network timeout');
    expect(state().kind).toBe('reauth_required');
    expect(state().session).toBeNull();
    await auth.connect({});
    expect(await auth.getAccessToken()).toBe(token.token);
    expect(auth.isTokenExpired()).toBe(false);
  });

  it('Scenario: Client credentials disconnect invalidates acquisition in both orders', async () => {
    for (const operation of ['connect', 'refresh', 'expired'] as const) {
      for (const disconnectFirst of [true, false]) {
        mocks.getToken.mockResolvedValue(operation === 'expired' ? { ...token, expiresOnTimestamp: 1 } : token);
        await auth.connect({});
        const { started, finish } = barrier();
        const acquisition = operation === 'connect' ? auth.connect({})
          : operation === 'refresh' ? auth.refresh() : auth.getAccessToken();
        const outcome = acquisition.then(() => 'ok', () => 'cancelled');
        await started.promise;
        if (disconnectFirst) {
          const disconnect = auth.disconnect();
          expect(auth.isTokenExpired()).toBe(true);
          expect(await auth.getAccessToken()).toBeUndefined();
          finish.resolve(replacement);
          expect(await outcome).toBe('cancelled');
          await disconnect;
        } else {
          finish.resolve(replacement);
          expect(await outcome).toBe('ok');
          expect(state().session).toMatchObject({ accessToken: replacement.token, expiresAt: replacement.expiresOnTimestamp });
          await auth.disconnect();
        }
        expect(state()).toEqual({ kind: 'disconnected' });
        expect(await auth.getAccessToken()).toBeUndefined();
      }
    }
  });

  it('invalidates queued changes and late failures without resurrecting reauth', async () => {
    for (const operation of ['connect', 'refresh'] as const) {
      await auth.connect({});
      const { started, finish } = barrier();
      const pending = operation === 'connect' ? auth.connect({}) : auth.refresh();
      const outcome = expect(pending).rejects.toThrow('cancelled');
      await started.promise;
      const queued = auth.connect({});
      const queuedOutcome = expect(queued).rejects.toThrow('cancelled');
      const disconnect = auth.disconnect();
      const secondDisconnect = auth.disconnect();
      const count = mocks.construct.mock.calls.length;
      finish.reject(new Error('invalid_client'));
      await Promise.all([outcome, queuedOutcome, disconnect, secondDisconnect]);
      expect(mocks.construct).toHaveBeenCalledTimes(count);
      expect(state()).toEqual({ kind: 'disconnected' });
    }
  });

  it('Scenario: Concurrent expired client credentials calls share refresh success and failure', async () => {
    for (const error of [null, new Error('network timeout'), new Error('invalid_client')]) {
      mocks.getToken.mockResolvedValueOnce({ ...token, expiresOnTimestamp: 1 });
      await auth.connect({});
      const count = mocks.getToken.mock.calls.length;
      const { started, finish } = barrier();
      const first = auth.getAccessToken();
      const second = auth.getAccessToken();
      await started.promise;
      const refresh = auth.refresh();
      expect(auth.refresh()).toBe(refresh);
      const outcomes = Promise.allSettled([first, second, refresh, auth.getAccessToken()]);
      expect(mocks.getToken.mock.calls.length - count).toBe(1);
      if (error) finish.reject(error); else finish.resolve(replacement);
      const results = await outcomes;
      expect(results.map(result => result.status)).toEqual(Array(4).fill(error ? 'rejected' : 'fulfilled'));
      if (error) {
        expect(results.every(result => result.status === 'rejected' && result.reason === error)).toBe(true);
        expect(state().session).toMatchObject({ accessToken: token.token, expiresAt: 1 });
      } else {
        expect(results[0]).toEqual({ status: 'fulfilled', value: replacement.token });
        expect(state().session).toMatchObject({ accessToken: replacement.token, expiresAt: replacement.expiresOnTimestamp });
      }
      expect(mocks.getToken.mock.calls.length - count).toBe(1);
    }
  });

  it('Scenario: Failed client credentials acquisition retains a coherent prior session', async () => {
    for (const operation of ['connect', 'refresh'] as const) {
      for (const priorConnected of [false, true]) {
        await auth.disconnect();
        if (priorConnected) await auth.connect({});
        for (const failure of [new Error('network timeout'), null]) {
          const prior = state();
          if (failure) mocks.getToken.mockRejectedValueOnce(failure);
          else mocks.getToken.mockResolvedValueOnce(null);
          const pending = operation === 'connect' ? auth.connect({}) : auth.refresh();
          await expect(pending).rejects.toThrow(!priorConnected && operation === 'refresh' ? 'Not connected'
            : failure?.message ?? (operation === 'connect' ? 'Failed to acquire' : 'Failed to refresh'));
          expect(state()).toBe(prior);
          if (!priorConnected && operation === 'refresh') mocks.getToken.mockReset().mockResolvedValue(token);
        }
      }
    }
  });

  it('Scenario: Successful client credentials acquisition replaces prior reauthentication state', async () => {
    await auth.connect({});
    for (const recovery of ['connect', 'refresh', 'token'] as const) {
      mocks.getToken.mockRejectedValueOnce(new Error('invalid_client'));
      await expect(auth.refresh()).rejects.toThrow('invalid_client');
      expect(state().kind).toBe('reauth_required');
      expect(auth.isTokenExpired()).toBe(true);
      const { started, finish } = barrier();
      const retry = auth.refresh();
      const failed = expect(retry).rejects.toThrow('network timeout');
      await started.promise;
      expect(auth.isTokenExpired()).toBe(true);
      finish.reject(new Error('network timeout'));
      await failed;
      expect(state().kind).toBe('reauth_required');
      mocks.getToken.mockResolvedValueOnce(replacement);
      if (recovery === 'connect') await auth.connect({});
      else if (recovery === 'refresh') await auth.refresh();
      else expect(await auth.getAccessToken()).toBe(replacement.token);
      expect(state().kind).toBe('connected');
      expect(auth.isTokenExpired()).toBe(false);
      expect(await auth.getAccessToken()).toBe(replacement.token);
    }
  });

  it('serializes connect and refresh so later success replaces earlier failure', async () => {
    for (const firstOperation of ['connect', 'refresh'] as const) {
      await auth.connect({});
      const { started, finish } = barrier();
      const pending = firstOperation === 'connect' ? auth.connect({}) : auth.refresh();
      const failed = expect(pending).rejects.toThrow('invalid_client');
      await started.promise;
      const count = mocks.getToken.mock.calls.length;
      const later = firstOperation === 'connect' ? auth.refresh() : auth.connect({});
      expect(mocks.getToken).toHaveBeenCalledTimes(count);
      mocks.getToken.mockResolvedValueOnce(replacement);
      finish.reject(new Error('invalid_client'));
      await failed;
      await later;
      expect(state().kind).toBe('connected');
      expect(await auth.getAccessToken()).toBe(replacement.token);
    }
  });

  it('new generation refresh survives stale flight cleanup', async () => {
    await auth.connect({});
    const { started, finish } = barrier();
    const old = auth.refresh();
    const cancelled = expect(old).rejects.toThrow('cancelled');
    await started.promise;
    const disconnect = auth.disconnect();
    const connect = auth.connect({});
    const next = auth.refresh();
    expect(next).not.toBe(old);
    expect(auth.refresh()).toBe(next);
    finish.resolve(token);
    await Promise.all([cancelled, disconnect, connect, next]);
    expect(state().kind).toBe('connected');
    expect(await auth.getAccessToken()).toBe(token.token);
    expect(mocks.getToken).toHaveBeenCalledTimes(4);
  });
});
