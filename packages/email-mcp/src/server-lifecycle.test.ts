// SM-1 / #237: lifecycle-safety initialization transitions and publication.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  microsoft: vi.fn(), gmail: vi.fn(), reconnect: vi.fn(), refresh: vi.fn(),
}));
vi.mock('@usejunior/provider-microsoft', () => ({
  listConfiguredMailboxesWithMetadata: mocks.microsoft,
  DelegatedAuthManager: class {
    constructor(_config: unknown, private name: string) {}
    reconnect() { return mocks.reconnect(this.name); }
    getAccessToken() { return 'synthetic'; }
    getTokenHealthWarning() { return undefined; }
    tryReconnect() { return Promise.resolve(true); }
  },
  RealGraphApiClient: class {}, GraphEmailProvider: class {},
}));
vi.mock('@usejunior/provider-gmail', async importOriginal => ({
  ...await importOriginal<typeof import('@usejunior/provider-gmail')>(),
  listConfiguredGmailMailboxes: mocks.gmail,
  GmailAuthManager: class {
    constructor(private config: { mailboxName: string }) {}
    connect() { return Promise.resolve(); }
    refresh() { return mocks.refresh(this.config.mailboxName); }
    getTokenHealthWarning() { return undefined; }
    tryReconnect() { return Promise.resolve(true); }
  },
  createGmailMetadataWriter: () => undefined,
  GoogleapisGmailClient: class {}, GmailEmailProvider: class {},
}));

import { buildLazyActions, createLazyProviderState, ensureProvider, initProvider, resetProviderState, waitForInit } from './server.js';

function microsoft(name: string) {
  return { mailboxName: name, emailAddress: `${name}@example.com`, clientId: 'synthetic', tenantId: 'synthetic' };
}
function gmail(name: string) {
  return { ...microsoft(name), source: 'manual', refreshToken: 'synthetic' };
}
function barrier() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('lifecycle-safety/provider initialization (#237)', () => {
  beforeEach(() => {
    mocks.microsoft.mockReset().mockResolvedValue([microsoft('work')]);
    mocks.gmail.mockReset().mockResolvedValue([]);
    mocks.reconnect.mockReset().mockResolvedValue(undefined);
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('direct and tool callers share initialization without publishing partial work', async () => {
    const gate = barrier();
    mocks.reconnect.mockReturnValue(gate.promise);
    const state = createLazyProviderState();
    const first = initProvider(state);
    expect(initProvider(state)).toBe(first);
    const callers = [waitForInit(state), ensureProvider(state)];
    await vi.waitFor(() => expect(mocks.reconnect).toHaveBeenCalledTimes(1));
    expect(state.status).toBe('connecting');
    expect(state.mailboxes).toEqual([]);
    expect(state.initPromise).toBe(first);
    gate.resolve();
    await Promise.all([first, ...callers]);
    expect(state.status).toBe('connected');
    expect(state.mailboxes[0]).toMatchObject({ name: 'work', isDefault: true, status: 'connected' });
    await initProvider(state);
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'])('ignores a late %s after configuration invalidates a generation', async outcome => {
    const gate = barrier();
    mocks.reconnect.mockReturnValueOnce(gate.promise);
    const state = createLazyProviderState();
    const old = initProvider(state);
    await vi.waitFor(() => expect(mocks.reconnect).toHaveBeenCalledTimes(1));
    resetProviderState(state);
    mocks.microsoft.mockResolvedValue([microsoft('new')]);
    await initProvider(state);
    if (outcome === 'success') gate.resolve();
    else gate.reject(new Error('invalid_grant'));
    await old;
    expect(state.status).toBe('connected');
    expect(state.error).toBeNull();
    expect(state.mailboxes.map(mailbox => mailbox.name)).toEqual(['new']);
  });

  it('keeps partial success ready and failed mailbox metadata inspectable with unchanged wire fields', async () => {
    mocks.microsoft.mockResolvedValue([microsoft('broken'), microsoft('work')]);
    mocks.gmail.mockResolvedValue([gmail('personal')]);
    mocks.reconnect.mockImplementation(async name => { if (name === 'broken') throw new Error('invalid_grant'); });
    const state = createLazyProviderState();
    await ensureProvider(state);
    const actions = await buildLazyActions(state, () => undefined);
    const listed = await actions.find(action => action.name === 'list_mailboxes')!.run({}, {});
    expect(listed).toEqual({ mailboxes: [
      { name: 'work', emailAddress: 'work@example.com', provider: 'microsoft', isDefault: true, status: 'connected' },
      { name: 'personal', emailAddress: 'personal@example.com', provider: 'gmail', isDefault: false, status: 'connected' },
      { name: 'broken', emailAddress: 'broken@example.com', provider: 'microsoft', isDefault: false, status: 'error', error: 'invalid_grant' },
    ] });
    const status = actions.find(action => action.name === 'get_mailbox_status')!;
    expect(await status.run({}, { mailbox: 'broken' })).toEqual({ name: 'broken@example.com', provider: 'microsoft', status: 'error', isDefault: false, warnings: ['invalid_grant'] });
    expect(await status.run({}, {})).toMatchObject({ name: 'work@example.com', status: 'connected', isDefault: true });
    await initProvider(state);
    expect(mocks.reconnect).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ms: ['z', 'a'], gm: ['g'], broken: [], expected: 'z' },
    { ms: ['z', 'a'], gm: ['g'], broken: ['z'], expected: 'a' },
    { ms: ['z', 'a'], gm: ['g', 'b'], broken: ['z', 'a'], expected: 'g' },
    { ms: [], gm: ['z', 'a'], broken: [], expected: 'z' },
  ])('preserves startup selection order: $expected', async ({ ms, gm, broken, expected }) => {
    mocks.microsoft.mockResolvedValue(ms.map(microsoft));
    mocks.gmail.mockResolvedValue(gm.map(gmail));
    mocks.reconnect.mockImplementation(async name => { if (broken.includes(name)) throw new Error('invalid_grant'); });
    const state = createLazyProviderState();
    await initProvider(state);
    expect(state.mailboxes.filter(mailbox => mailbox.isDefault).map(mailbox => mailbox.name)).toEqual([expected]);
    // Projection mutations cannot change the selected internal identity.
    state.mailboxes[0]!.isDefault = false;
    expect(state.mailboxes.find(mailbox => mailbox.isDefault)?.name).toBe(expected);
  });

  it('retries a transient all-failed init only on a call at/after 30s, sharing that retry', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.reconnect.mockRejectedValueOnce(new Error('network timeout'));
    const state = createLazyProviderState();
    await expect(ensureProvider(state)).rejects.toThrow('network timeout');
    expect(state.mailboxes[0]).toMatchObject({ status: 'error', error: 'network timeout', isDefault: false });
    now += 29_999;
    await expect(ensureProvider(state)).rejects.toThrow('network timeout');
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
    now++;
    expect(mocks.reconnect).toHaveBeenCalledTimes(1); // elapsed time alone does nothing
    await Promise.all([ensureProvider(state), ensureProvider(state), initProvider(state)]);
    expect(mocks.reconnect).toHaveBeenCalledTimes(2);
    expect(state.status).toBe('connected');
    expect(state.error).toBeNull();
  });

  it.each([
    new Error('invalid_grant: network request rejected'),
    Object.assign(new Error('credentials required'), { name: 'AuthenticationRequiredError' }),
    Object.assign(new Error('unauthorized'), { status: 401 }),
    new Error('unclassified failure'),
  ])('requires configure for terminal/unknown errors: %s', async error => {
    mocks.reconnect.mockRejectedValue(error);
    const state = createLazyProviderState();
    await initProvider(state);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    await initProvider(state);
    expect(state.status).toBe('error');
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
    resetProviderState(state);
    mocks.reconnect.mockResolvedValue(undefined);
    await ensureProvider(state);
    expect(mocks.reconnect).toHaveBeenCalledTimes(2);
  });

  it('does not reauthenticate terminal mailboxes while retrying transient siblings', async () => {
    mocks.microsoft.mockResolvedValue([microsoft('terminal'), microsoft('transient')]);
    mocks.reconnect.mockImplementation(async name => { throw new Error(name === 'terminal' ? 'invalid_grant' : 'network timeout'); });
    const state = createLazyProviderState();
    await initProvider(state);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    mocks.reconnect.mockResolvedValue(undefined);
    await ensureProvider(state);
    expect(mocks.reconnect.mock.calls.map(call => call[0])).toEqual(['terminal', 'transient', 'transient']);
    expect(state.mailboxes.map(mailbox => [mailbox.name, mailbox.status])).toEqual([['transient', 'connected'], ['terminal', 'error']]);
  });

  it('classifies discovery and Gmail service failures as transient but Gmail revoked credentials as terminal', async () => {
    mocks.microsoft.mockRejectedValueOnce(Object.assign(new Error('service unavailable'), { status: 503 }));
    const state = createLazyProviderState();
    await initProvider(state);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    mocks.microsoft.mockResolvedValue([]);
    mocks.gmail.mockResolvedValue([gmail('revoked'), gmail('service')]);
    mocks.refresh.mockImplementation(async name => {
      if (name === 'revoked@example.com') throw Object.assign(new Error('request failed'), { response: { status: 503, data: { error: 'invalid_grant' } } });
      throw Object.assign(new Error('request failed'), { response: { status: 503 } });
    });
    await initProvider(state);
    expect(state.status).toBe('error');
    vi.mocked(Date.now).mockReturnValue(Date.now() + 30_000);
    mocks.refresh.mockResolvedValue(undefined);
    await ensureProvider(state);
    expect(mocks.refresh.mock.calls.map(call => call[0])).toEqual(['revoked@example.com', 'service@example.com', 'service@example.com']);
  });

  it('zero configuration is settled demo mode without authentication or retry', async () => {
    mocks.microsoft.mockResolvedValue([]);
    const state = createLazyProviderState();
    await initProvider(state);
    expect(state.status).toBe('not_configured');
    expect(state.isDemo).toBe(true);
    expect(state.mailboxes).toEqual([]);
    await initProvider(state);
    expect(mocks.microsoft).toHaveBeenCalledTimes(1);
    expect(mocks.reconnect).not.toHaveBeenCalled();
    await expect(ensureProvider(state)).rejects.toThrow('No mailbox configured');
  });

  it.each(['get_mailbox_status', 'list_mailboxes'])('one-shot CLI %s settles initialization and emits only JSON on stdout', async callTool => {
    vi.stubEnv('AGENT_EMAIL_SEND_ALLOWLIST', '/tmp/email-sm-237-synthetic-absent-allowlist.json');
    mocks.reconnect.mockRejectedValue(new Error('invalid_grant'));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { runCall } = await import('./cli.js');
    expect(await runCall({ command: 'call', callTool, callArgs: '{}' })).toBe(0);
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
    const result = JSON.parse(String(output.mock.calls[0]![0]));
    expect(callTool === 'get_mailbox_status' ? result : result.mailboxes[0]).toMatchObject({ status: 'error', isDefault: false });
  });

  it('a non-blocking status call starts an eligible retry and projects connecting', async () => {
    mocks.reconnect.mockRejectedValueOnce(new Error('network timeout'));
    const state = createLazyProviderState();
    await initProvider(state);
    const actions = await buildLazyActions(state, () => undefined);
    const status = actions.find(action => action.name === 'get_mailbox_status')!;
    expect(await status.run({}, {})).toMatchObject({ status: 'error' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    const gate = barrier();
    mocks.reconnect.mockReturnValue(gate.promise);
    expect(await status.run({}, {})).toMatchObject({ status: 'connecting' });
    expect(await status.run({}, {})).toMatchObject({ status: 'connecting' });
    gate.resolve();
    await waitForInit(state);
    expect(mocks.reconnect).toHaveBeenCalledTimes(2);
    expect(await status.run({}, {})).toMatchObject({ status: 'connected' });
  });

  it('legacy writes invalidate pending publication and preserve the mutable compatibility API', async () => {
    const gate = barrier();
    mocks.reconnect.mockReturnValue(gate.promise);
    const state = createLazyProviderState();
    const pending = initProvider(state);
    await vi.waitFor(() => expect(mocks.reconnect).toHaveBeenCalledTimes(1));
    state.status = 'error';
    state.error = 'external fixture failure';
    gate.resolve();
    await pending;
    await expect(ensureProvider(state)).rejects.toThrow('external fixture failure');
    expect(state.status).toBe('error');
  });
});
