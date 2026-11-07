import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DelegatedAuthManager, type MailboxMetadata } from './auth.js';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getToken: vi.fn(),
  options: [] as Record<string, unknown>[],
  beforeWrite: null as null | (() => Promise<void>),
}));

vi.mock('@azure/identity', () => ({
  useIdentityPlugin: vi.fn(),
  ClientSecretCredential: vi.fn(),
  DeviceCodeCredential: class {
    constructor(options: Record<string, unknown>) { mocks.options.push(options); }
    authenticate = mocks.authenticate;
    getToken = mocks.getToken;
  },
}));
vi.mock('@azure/identity-cache-persistence', () => ({ cachePersistencePlugin: {} }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      await mocks.beforeWrite?.();
      return original.writeFile(...args);
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const record = {
  authority: 'https://login.microsoftonline.com', homeAccountId: 'synthetic',
  clientId: 'synthetic-client', tenantId: 'synthetic-tenant', username: 'user@example.test',
};
const token = { token: 'synthetic-token', expiresOnTimestamp: 12345678900000 };
const metadata: MailboxMetadata = {
  authenticationRecord: record, cacheName: 'synthetic-cache',
  lastInteractiveAuthAt: '2026-01-01T00:00:00.000Z',
  clientId: 'synthetic-client', mailboxName: 'work', emailAddress: 'user@example.test',
};

describe('provider-microsoft/Delegated authentication lifecycle', () => {
  let home: string;
  let auth: DelegatedAuthManager;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ms-delegated-lifecycle-'));
    vi.stubEnv('EMAIL_AGENT_MCP_HOME', home);
    mocks.authenticate.mockReset().mockResolvedValue(record);
    mocks.getToken.mockReset().mockResolvedValue(token);
    mocks.options.length = 0;
    mocks.beforeWrite = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    auth = new DelegatedAuthManager({ mode: 'delegated', clientId: 'synthetic-client' }, 'work');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function savedProfile() {
    return vi.spyOn(auth as unknown as { loadMetadata(): Promise<MailboxMetadata | null> }, 'loadMetadata')
      .mockResolvedValue(metadata);
  }

  function expectDisconnected() {
    expect(auth.tokenExpiresAt).toBeNull();
    expect(auth.lastInteractiveAuthAt).toBeNull();
    expect(auth.emailAddress).toBeNull();
    expect(auth.needsReauth).toBe(false);
    expect((auth as unknown as { state: { kind: string } }).state.kind).toBe('disconnected');
  }

  it('Scenario: Disconnect invalidates delegated acquisition in either completion order', async () => {
    for (const operation of ['connect', 'reconnect', 'token'] as const) {
      for (const disconnectFirst of [true, false]) {
        savedProfile();
        await auth.connect({});
        await auth.getAccessToken();
        const started = deferred<void>();
        const finish = deferred<typeof token>();
        const authenticateFinish = deferred<typeof record>();
        if (operation === 'connect') {
          mocks.authenticate.mockImplementationOnce(() => {
            started.resolve(); return authenticateFinish.promise;
          });
        } else {
          mocks.getToken.mockImplementationOnce(() => {
            started.resolve(); return finish.promise;
          });
        }
        const oldMetadata = await readFile(join(home, 'tokens/work.json'), 'utf-8');
        const acquisition = operation === 'connect' ? auth.connect({})
          : operation === 'reconnect' ? auth.reconnect() : auth.getAccessToken();
        const outcome = acquisition.then(() => 'ok', () => 'cancelled');
        await started.promise;
        let disconnect: Promise<void>;
        if (disconnectFirst) {
          disconnect = auth.disconnect();
          // Runtime access is revoked before disconnect drains the old operation.
          expect(auth.tokenExpiresAt).toBeNull();
          expect(auth.emailAddress).toBeNull();
          const denied = auth.getAccessToken();
          const deniedOutcome = expect(denied).rejects.toThrow('Not connected');
          finish.resolve(token);
          authenticateFinish.resolve(record);
          expect(await outcome).toBe('cancelled');
          await disconnect;
          await deniedOutcome;
          expect(await readFile(join(home, 'tokens/work.json'), 'utf-8')).toBe(oldMetadata);
        } else {
          finish.resolve(token);
          authenticateFinish.resolve(record);
          expect(await outcome).toBe('ok');
          await auth.disconnect();
        }
        expectDisconnected();
      }
    }
  });

  it('invalidates metadata loading and queued operations before constructing a credential', async () => {
    const started = deferred<void>();
    const finish = deferred<MailboxMetadata>();
    savedProfile().mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const reconnect = auth.reconnect();
    const outcome = expect(reconnect).rejects.toThrow('cancelled');
    await started.promise;
    const queued = auth.connect({});
    const queuedOutcome = expect(queued).rejects.toThrow('cancelled');
    const disconnect = auth.disconnect();
    const secondDisconnect = auth.disconnect();
    finish.resolve(metadata);
    await Promise.all([outcome, queuedOutcome, disconnect, secondDisconnect]);
    expect(mocks.options).toHaveLength(0);
    expectDisconnected();
  });

  it('late terminal failures cannot restore reauth after disconnect', async () => {
    for (const operation of ['connect', 'reconnect', 'token'] as const) {
      await auth.connect({});
      savedProfile();
      const started = deferred<void>();
      const finish = deferred<never>();
      const fail = () => { started.resolve(); return finish.promise; };
      if (operation === 'connect') mocks.authenticate.mockImplementationOnce(fail);
      else mocks.getToken.mockImplementationOnce(fail);
      const pending = operation === 'connect' ? auth.connect({})
        : operation === 'reconnect' ? auth.reconnect() : auth.getAccessToken();
      const outcome = expect(pending).rejects.toThrow('cancelled');
      await started.promise;
      const disconnect = auth.disconnect();
      finish.reject(new Error('invalid_grant'));
      await Promise.all([outcome, disconnect]);
      expectDisconnected();
    }
  });

  it('new generation acquisitions survive stale flight cleanup', async () => {
    await auth.connect({});
    const started = deferred<void>();
    const finish = deferred<typeof token>();
    mocks.getToken.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const oldToken = auth.getAccessToken();
    const cancelled = expect(oldToken).rejects.toThrow('cancelled');
    await started.promise;
    const disconnect = auth.disconnect();
    savedProfile();
    const reconnect = auth.reconnect();
    const newToken = auth.getAccessToken();
    expect(newToken).not.toBe(oldToken);
    expect(auth.getAccessToken()).toBe(newToken);
    finish.resolve(token);
    await Promise.all([cancelled, disconnect, reconnect]);
    expect(await newToken).toBe(token.token);
    expect(auth.needsReauth).toBe(false);
    expect(auth.emailAddress).toBe(metadata.emailAddress);
    expect(mocks.getToken).toHaveBeenCalledTimes(3);
  });

  it('Scenario: Concurrent delegated refresh callers share success and failure', async () => {
    await auth.connect({});
    for (const error of [null, new Error('network timeout'), new Error('invalid_grant')]) {
      const started = deferred<void>();
      const finish = deferred<typeof token>();
      mocks.getToken.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
      const count = mocks.getToken.mock.calls.length;
      const first = auth.getAccessToken();
      const second = auth.getAccessToken();
      expect(second).toBe(first);
      const outcomes = Promise.allSettled([first, second, auth.refresh(), auth.refresh()]);
      await started.promise;
      expect(mocks.getToken.mock.calls.length - count).toBe(1);
      if (error) finish.reject(error); else finish.resolve(token);
      const results = await outcomes;
      expect(results.every(result => result.status === (error ? 'rejected' : 'fulfilled'))).toBe(true);
      expect(auth.tokenExpiresAt).toBe(token.expiresOnTimestamp);
      expect(auth.needsReauth).toBe(error?.message === 'invalid_grant');
    }
    // A later successful acquisition clears terminal state rather than leaving a stale flag.
    expect(await auth.getAccessToken()).toBe(token.token);
    expect(auth.needsReauth).toBe(false);
    expect(auth.isTokenExpiringSoon).toBe(false);
  });

  it('Scenario: Concurrent delegated reconnect callers share success and failure', async () => {
    const load = savedProfile();
    for (const error of [new Error('network timeout'), new Error('interaction_required'), null]) {
      const started = deferred<void>();
      const finish = deferred<typeof token>();
      mocks.getToken.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
      const first = auth.reconnect();
      const second = auth.reconnect();
      expect(second).toBe(first);
      const outcomes = Promise.allSettled([first, second, auth.tryReconnect(), auth.tryReconnect()]);
      await started.promise;
      if (error) finish.reject(error); else finish.resolve(token);
      const results = await outcomes;
      expect(results[0]!.status).toBe(error ? 'rejected' : 'fulfilled');
      expect(results[1]!.status).toBe(error ? 'rejected' : 'fulfilled');
      expect(results.slice(2)).toEqual([
        { status: 'fulfilled', value: !error }, { status: 'fulfilled', value: !error },
      ]);
      expect(auth.needsReauth).toBe(error?.message === 'interaction_required');
    }
    expect(load).toHaveBeenCalledTimes(3);
    expect(mocks.getToken).toHaveBeenCalledTimes(3);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it('Scenario: Transient delegated failures retain the prior coherent session', async () => {
    await auth.connect({});
    await auth.getAccessToken();
    auth.setEmailAddress('prior@example.test');
    const snapshot = [auth.emailAddress, auth.lastInteractiveAuthAt, auth.tokenExpiresAt];
    savedProfile();
    for (const operation of [() => auth.reconnect(), () => auth.connect({}), () => auth.getAccessToken()]) {
      mocks.authenticate.mockRejectedValueOnce(new Error('network timeout'));
      mocks.getToken.mockRejectedValueOnce(new Error('network timeout'));
      await expect(operation()).rejects.toThrow('network timeout');
      expect([auth.emailAddress, auth.lastInteractiveAuthAt, auth.tokenExpiresAt]).toEqual(snapshot);
      expect(auth.needsReauth).toBe(false);
      mocks.authenticate.mockReset().mockResolvedValue(record);
      mocks.getToken.mockReset().mockResolvedValue(token);
    }
    await auth.disconnect();
    await expect(auth.getAccessToken()).rejects.toThrow('Not connected');
    await expect(auth.saveMetadata()).rejects.toThrow('Not connected');
  });

  it('serializes reconnect behind refresh so a later success clears an earlier terminal failure', async () => {
    await auth.connect({});
    const started = deferred<void>();
    const finish = deferred<typeof token>();
    mocks.getToken.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const refresh = auth.refresh();
    const outcome = expect(refresh).rejects.toThrow('invalid_grant');
    await started.promise;
    const load = savedProfile();
    const reconnect = auth.reconnect();
    expect(load).not.toHaveBeenCalled();
    finish.reject(new Error('invalid_grant'));
    await outcome;
    await reconnect;
    expect(auth.needsReauth).toBe(false);
    expect(auth.emailAddress).toBe(metadata.emailAddress);
    expect(auth.tokenExpiresAt).toBe(token.expiresOnTimestamp);
  });

  it('retains reauth during a pending retry and its transient failure', async () => {
    await auth.connect({});
    mocks.getToken.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(auth.refresh()).rejects.toThrow('invalid_grant');
    const started = deferred<void>();
    const finish = deferred<typeof token>();
    mocks.getToken.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const retry = auth.getAccessToken();
    const outcome = expect(retry).rejects.toThrow('network timeout');
    await started.promise;
    expect(auth.needsReauth).toBe(true);
    finish.reject(new Error('network timeout'));
    await outcome;
    expect(auth.needsReauth).toBe(true);
    await auth.refresh();
    expect(auth.needsReauth).toBe(false);
  });

  it('Scenario: Delegated metadata persistence failure retains runtime authentication', async () => {
    mocks.beforeWrite = async () => { throw new Error('synthetic disk full'); };
    await expect(auth.connect({})).rejects.toThrow('failed to persist Microsoft mailbox metadata');
    expect(auth.lastInteractiveAuthAt).toBeTruthy();
    expect(auth.needsReauth).toBe(false);
    expect(await auth.getAccessToken()).toBe(token.token);
    expect(await readdir(join(home, 'tokens'))).toEqual([]);
    mocks.beforeWrite = null;
    auth.setEmailAddress('user@example.test');
    await auth.saveMetadata();
    const saved = JSON.parse(await readFile(join(home, 'tokens/user-at-example-test.json'), 'utf-8'));
    expect(saved.authenticationRecord).toEqual(record);
    expect(saved).not.toHaveProperty('token');
    await auth.disconnect();
    expect(JSON.parse(await readFile(join(home, 'tokens/user-at-example-test.json'), 'utf-8'))).toEqual(saved);
  });

  it('Scenario: Disconnect prevents pending delegated metadata publication', async () => {
    await auth.connect({});
    const prior = await readFile(join(home, 'tokens/work.json'), 'utf-8');
    const started = deferred<void>();
    const finish = deferred<void>();
    mocks.beforeWrite = () => { started.resolve(); return finish.promise; };
    const connect = auth.connect({});
    const outcome = expect(connect).rejects.toThrow('cancelled');
    await started.promise;
    const disconnect = auth.disconnect();
    finish.resolve();
    await Promise.all([outcome, disconnect]);
    expectDisconnected();
    expect(await readFile(join(home, 'tokens/work.json'), 'utf-8')).toBe(prior);
    expect(await readdir(join(home, 'tokens'))).toEqual(['work.json']);
  });

  it('Scenario: Unconsented delegated scopes fail silently without stdout prompts', async () => {
    savedProfile();
    const stdout = vi.spyOn(process.stdout, 'write');
    const required = new Error('Scopes were never consented');
    required.name = 'AuthenticationRequiredError';
    mocks.getToken.mockRejectedValueOnce(required);
    await expect(auth.reconnect()).rejects.toThrow('configure --mailbox work');
    expect(auth.needsReauth).toBe(true);
    expect(auth.isTokenExpired()).toBe(true);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.options[0]!.disableAutomaticAuthentication).toBe(true);
    const prompt = mocks.options[0]!.userPromptCallback as (info: unknown) => void;
    prompt({ verificationUri: 'https://example.test', userCode: 'SYNTHETIC' });
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    await auth.connect({});
    expect(auth.needsReauth).toBe(false);
    mocks.getToken.mockRejectedValueOnce(required);
    await expect(auth.getAccessToken()).rejects.toBe(required);
    expect(auth.needsReauth).toBe(true);
    expect(await auth.getAccessToken()).toBe(token.token);
    expect(auth.needsReauth).toBe(false);
  });
});
