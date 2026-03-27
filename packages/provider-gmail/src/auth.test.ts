import { describe, it, expect, vi } from 'vitest';
import { GmailAuthManager } from './auth.js';

// Mock google-auth-library so tests don't make real HTTP calls
vi.mock('google-auth-library', () => {
  const setCredentialsFn = vi.fn();
  const revokeTokenFn = vi.fn().mockResolvedValue({});
  const generateAuthUrlFn = vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?test=1');
  const getTokenFn = vi.fn().mockResolvedValue({
    tokens: { access_token: 'exchanged-token', refresh_token: 'exchanged-refresh' },
  });
  const refreshAccessTokenFn = vi.fn().mockResolvedValue({
    credentials: { access_token: 'refreshed-token', expiry_date: Date.now() + 3600000 },
  });

  class MockOAuth2Client {
    setCredentials = setCredentialsFn;
    revokeToken = revokeTokenFn;
    generateAuthUrl = generateAuthUrlFn;
    getToken = getTokenFn;
    refreshAccessToken = refreshAccessTokenFn;
  }

  return { OAuth2Client: MockOAuth2Client };
});

describe('provider-gmail/OAuth2 Authentication', () => {
  it('Scenario: Gmail OAuth', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    // Initiate OAuth2 flow and persist refresh tokens
    await auth.connect({ access_token: 'gmail-token', refresh_token: 'gmail-refresh' });

    expect(auth.getAccessToken()).toBe('gmail-token');
    expect(auth.isTokenExpired()).toBe(false);

    // OAuth2Client.setCredentials was called with tokens
    const oauthClient = auth.getOAuth2Client();
    expect(oauthClient.setCredentials).toHaveBeenCalledWith({
      access_token: 'gmail-token',
      refresh_token: 'gmail-refresh',
    });

    // Refresh works via OAuth2Client
    await auth.refresh();
    expect(auth.getAccessToken()).toBe('refreshed-token');
    expect(auth.isTokenExpired()).toBe(false);
  });

  it('Scenario: connect requires credentials', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    await expect(auth.connect({})).rejects.toThrow('access_token or refresh_token');
  });

  it('Scenario: generateAuthUrl returns OAuth2 URL', () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    const url = auth.generateAuthUrl();
    expect(url).toContain('accounts.google.com');
  });

  it('Scenario: disconnect revokes token', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    await auth.connect({ access_token: 'gmail-token', refresh_token: 'gmail-refresh' });
    await auth.disconnect();

    expect(auth.getAccessToken()).toBeUndefined();
    expect(auth.isTokenExpired()).toBe(true);
    expect(auth.getOAuth2Client().revokeToken).toHaveBeenCalledWith('gmail-token');
  });

  it('Scenario: refresh without refresh_token throws', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    // Connect with only access_token, no refresh_token
    await auth.connect({ access_token: 'gmail-token' });
    await expect(auth.refresh()).rejects.toThrow('No refresh token');
  });
});
