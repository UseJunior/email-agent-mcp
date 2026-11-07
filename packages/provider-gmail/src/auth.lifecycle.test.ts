import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { GmailAuthManager } from './auth.js';

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const config = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('provider-gmail/Auth lifecycle safety (#240)', () => {
  it('Scenario: Gmail disconnect invalidates access before revocation finishes', async () => {
    const entered = barrier<void>();
    const release = barrier<void>();
    vi.spyOn(OAuth2Client.prototype, 'revokeToken').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('synthetic revoke failure');
    });
    const auth = new GmailAuthManager(config);
    await auth.connect({ access_token: 'old-access', refresh_token: 'old-refresh' });
    const retired = auth.getOAuth2Client();
    const pending = auth.disconnect();
    await entered.promise;
    expect(auth.getAccessToken()).toBeUndefined();
    expect(auth.getRefreshToken()).toBeUndefined();
    retired.emit('tokens', { access_token: 'late-event', refresh_token: 'late-refresh' });
    // A new connection is not cleared by the old revocation completion.
    await auth.connect({ access_token: 'new-access', refresh_token: 'new-refresh' });
    release.resolve();
    await pending;
    expect(auth.getAccessToken()).toBe('new-access');
    expect(auth.getRefreshToken()).toBe('new-refresh');
  });

  it('Scenario: Disconnect invalidates an in-flight Gmail refresh', async () => {
    for (const kind of ['explicit', 'automatic'] as const) {
    const entered = barrier<void>();
    const release = barrier<void>();
    const writer = vi.fn();
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockImplementation(async function(this: OAuth2Client) {
      entered.resolve();
      await release.promise;
      this.emit('tokens', { access_token: 'late-access', refresh_token: 'late-rotation' });
      return { credentials: { access_token: 'late-access', refresh_token: 'old' }, res: null };
    });
    const auth = new GmailAuthManager({ ...config, metadataWriter: writer });
    await auth.connect({ refresh_token: 'old' });
    const oldClient = auth.getOAuth2Client();
    const pending = kind === 'explicit' ? auth.refresh() : oldClient.getRequestHeaders();
    const rejected = expect(pending).rejects.toThrow('superseded');
    await entered.promise;
    await auth.disconnect();
    release.resolve();
    await rejected;
    expect(auth.getAccessToken()).toBeUndefined();
    expect(auth.getRefreshToken()).toBeUndefined();
    expect(oldClient.credentials).toEqual({});
    expect(auth.getOAuth2Client().credentials).toEqual({});
    expect(writer).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    }
  });

  it('Scenario: Concurrent explicit and automatic Gmail refresh share one acquisition', async () => {
    const entered = barrier<void>();
    const release = barrier<void>();
    const transport = vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockImplementation(async function(this: OAuth2Client) {
      entered.resolve();
      await release.promise;
      this.emit('tokens', { access_token: 'new', refresh_token: 'rotated', expiry_date: Date.now() + 3600000 });
      return { credentials: { access_token: 'new', refresh_token: 'old' }, res: null };
    });
    const writer = vi.fn().mockResolvedValue(undefined);
    const auth = new GmailAuthManager({ ...config, metadataWriter: writer });
    await auth.connect({ refresh_token: 'old' });
    const first = auth.refresh();
    await entered.promise;
    const second = auth.refresh();
    const automatic = auth.getOAuth2Client().getRequestHeaders();
    release.resolve();
    await Promise.all([first, second, automatic]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(auth.getRefreshToken()).toBe('rotated');
    expect(auth.getOAuth2Client().credentials.refresh_token).toBe('rotated');
    expect(writer).toHaveBeenCalledExactlyOnceWith('rotated', 'old');
  });

  it('Scenario: Gmail token events persist rotations in order', async () => {
    const entered = barrier<void>();
    const release = barrier<void>();
    const writes: string[] = [];
    const finished = barrier<void>();
    const writer = vi.fn(async (token: string) => {
      writes.push(token);
      if (token === 'rotation-1') { entered.resolve(); await release.promise; }
      if (token === 'rotation-2') finished.resolve();
    });
    const auth = new GmailAuthManager({ ...config, metadataWriter: writer });
    await auth.connect({ access_token: 'access', refresh_token: 'original' });
    auth.getOAuth2Client().emit('tokens', { refresh_token: 'rotation-1' });
    await entered.promise;
    auth.getOAuth2Client().emit('tokens', { refresh_token: 'rotation-2' });
    expect(auth.getRefreshToken()).toBe('rotation-2');
    expect(writes).toEqual(['rotation-1']);
    release.resolve();
    await finished.promise;
    expect(writes).toEqual(['rotation-1', 'rotation-2']);
    expect(writer.mock.calls[1]).toEqual(['rotation-2', 'rotation-1']);
  });

  it('Scenario: Gmail rotation persistence failure preserves runtime authentication', async () => {
    for (const mode of ['byok', 'broker'] as const) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockResolvedValue({
      credentials: { access_token: 'new-access', refresh_token: 'new-refresh' }, res: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
    })));
    vi.stubGlobal('fetch', fetchMock);
    const writer = vi.fn().mockRejectedValue(new Error('synthetic storage failure'));
    const auth = new GmailAuthManager({ ...(mode === 'byok' ? config : { brokerUrl: 'https://broker.test' }), metadataWriter: writer });
    await auth.connect({ refresh_token: 'old-refresh' });
    await expect(auth.refresh()).resolves.toBeUndefined();
    expect(auth.getAccessToken()).toBe('new-access');
    expect(auth.getRefreshToken()).toBe('new-refresh');
    expect(auth.getTokenHealthWarning()).toContain('could not be saved');
    expect(writer).toHaveBeenCalledExactlyOnceWith('new-refresh', 'old-refresh');
    if (mode === 'broker') {
      expect(auth.getOAuth2Client().credentials.refresh_token).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    }
  });

  it('Scenario: Gmail expired profile token is refreshed before use', async () => {
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockResolvedValue({
      credentials: { access_token: 'fresh' }, res: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ emailAddress: 'synthetic@example.com' })));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new GmailAuthManager(config);
    await auth.connect({ access_token: 'expired', refresh_token: 'refresh' }, { expiresInSeconds: -1 });
    expect(auth.getAccessToken()).toBeUndefined();
    await auth.fetchProfile();
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), { headers: { Authorization: 'Bearer fresh' } });
  });

  it('Scenario: Gmail terminal errors require configure while transient errors retain the session', async () => {
    const refresh = vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken');
    const auth = new GmailAuthManager(config);
    await auth.connect({ access_token: 'valid', refresh_token: 'refresh' });
    refresh.mockRejectedValueOnce(new Error('network timeout'));
    await expect(auth.refresh()).rejects.toThrow('network timeout');
    expect(auth.getAccessToken()).toBe('valid');
    expect(auth.getRefreshToken()).toBe('refresh');
    refresh.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(auth.refresh()).rejects.toThrow('invalid_grant');
    expect(auth.getAccessToken()).toBeUndefined();
    expect(auth.getOAuth2Client().credentials).toEqual({});
    expect(auth.getTokenHealthWarning()).toContain('configure');
    expect(await auth.tryReconnect()).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Broker automatic refresh cannot restore access after disconnect', async () => {
    const entered = barrier<void>();
    const response = barrier<Response>();
    vi.stubGlobal('fetch', vi.fn(async () => { entered.resolve(); return response.promise; }));
    const writer = vi.fn();
    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test', metadataWriter: writer });
    await auth.connect({ refresh_token: 'broker-refresh' });
    const client = auth.getOAuth2Client();
    const pending = expect(client.getRequestHeaders()).rejects.toThrow('superseded');
    await entered.promise;
    await auth.disconnect();
    response.resolve(new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh' })));
    await pending;
    expect(client.credentials).toEqual({});
    expect(auth.getAccessToken()).toBeUndefined();
    expect(writer).not.toHaveBeenCalled();
  });

  it('Scenario: Broker concurrent refresh persists rotation without exposing refresh credentials', async () => {
    const entered = barrier<void>();
    const response = barrier<Response>();
    const fetchMock = vi.fn(async () => { entered.resolve(); return response.promise; });
    vi.stubGlobal('fetch', fetchMock);
    const writer = vi.fn().mockResolvedValue(undefined);
    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test', metadataWriter: writer });
    await auth.connect({ refresh_token: 'original' });
    const automatic = auth.getOAuth2Client().getRequestHeaders();
    await entered.promise;
    const explicit = auth.refresh();
    response.resolve(new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotation', expires_in: 3600 })));
    await Promise.all([automatic, explicit]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledExactlyOnceWith('rotation', 'original');
    expect(auth.getRefreshToken()).toBe('rotation');
    expect(auth.getAccessToken()).toBe('new-access');
    expect(auth.getOAuth2Client().credentials.refresh_token).toBeUndefined();
  });
});
