import { describe, it, expect, beforeEach } from 'vitest';
import { DelegatedAuthManager, ClientCredentialsAuthManager, persistRefreshToken, loadRefreshToken } from './auth.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

describe('provider-microsoft/Delegated OAuth Authentication', () => {
  it('Scenario: Device code flow', async () => {
    const auth = new DelegatedAuthManager({
      mode: 'delegated',
      clientId: 'test-client-id',
    });

    // Initiate auth — in real impl this would start device code flow
    await auth.connect({ access_token: 'test-token', refresh_token: 'test-refresh' });

    expect(auth.getAccessToken()).toBe('test-token');
    expect(auth.getRefreshToken()).toBe('test-refresh');
    expect(auth.isTokenExpired()).toBe(false);
  });

  it('Scenario: Refresh token persistence', async () => {
    const configDir = join(tmpdir(), `agent-email-test-${Date.now()}`);
    await mkdir(configDir, { recursive: true });

    // Persist a refresh token
    await persistRefreshToken(configDir, 'work', 'encrypted-refresh-token');

    // Load it back (simulating server restart)
    const loaded = await loadRefreshToken(configDir, 'work');
    expect(loaded).toBe('encrypted-refresh-token');

    // Resume auth with loaded token
    const auth = new DelegatedAuthManager({ mode: 'delegated', clientId: 'test' });
    auth.setTokens({ refreshToken: loaded, expiresAt: 0 });
    expect(auth.isTokenExpired()).toBe(true);
    await auth.refresh();
    expect(auth.isTokenExpired()).toBe(false);

    await rm(configDir, { recursive: true, force: true });
  });
});

describe('provider-microsoft/Client Credentials Authentication', () => {
  it('Scenario: Client credentials', async () => {
    const auth = new ClientCredentialsAuthManager({
      mode: 'client_credentials',
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      tenantId: 'test-tenant',
    });

    await auth.connect({});
    expect(auth.getAccessToken()).toBeDefined();
    expect(auth.isTokenExpired()).toBe(false);

    // Refresh produces a new token
    const firstToken = auth.getAccessToken();
    await auth.refresh();
    expect(auth.getAccessToken()).toBeDefined();
    expect(auth.getAccessToken()).not.toBe(firstToken);
  });
});
