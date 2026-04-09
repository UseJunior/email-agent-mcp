import { afterEach, describe, expect, it, vi } from 'vitest';
import { GMAIL_OAUTH_SCOPES, GmailAuthManager } from './auth.js';

const oauthMocks = vi.hoisted(() => ({
  setCredentials: vi.fn(),
  revokeToken: vi.fn().mockResolvedValue({}),
  generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?test=1'),
  generateCodeVerifierAsync: vi.fn().mockResolvedValue({
    codeVerifier: 'pkce-verifier',
    codeChallenge: 'pkce-challenge',
  }),
  getToken: vi.fn().mockResolvedValue({
    tokens: {
      access_token: 'exchanged-token',
      refresh_token: 'exchanged-refresh',
      expiry_date: Date.now() + 3600000,
    },
  }),
  refreshAccessToken: vi.fn().mockResolvedValue({
    credentials: { access_token: 'refreshed-token', expiry_date: Date.now() + 3600000 },
  }),
}));

vi.mock('google-auth-library', () => {
  class MockOAuth2Client {
    setCredentials = oauthMocks.setCredentials;
    revokeToken = oauthMocks.revokeToken;
    generateAuthUrl = oauthMocks.generateAuthUrl;
    generateCodeVerifierAsync = oauthMocks.generateCodeVerifierAsync;
    getToken = oauthMocks.getToken;
    refreshAccessToken = oauthMocks.refreshAccessToken;
  }

  return {
    CodeChallengeMethod: { S256: 'S256' },
    OAuth2Client: MockOAuth2Client,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provider-gmail/OAuth2 Authentication', () => {
  it('Scenario: Gmail OAuth', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    await auth.connect({ access_token: 'gmail-token', refresh_token: 'gmail-refresh' });

    expect(auth.getAccessToken()).toBe('gmail-token');
    expect(auth.getRefreshToken()).toBe('gmail-refresh');
    expect(auth.isTokenExpired()).toBe(false);
    expect(auth.getOAuth2Client().setCredentials).toHaveBeenCalledWith({
      access_token: 'gmail-token',
      refresh_token: 'gmail-refresh',
    });

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

  it('Scenario: generateAuthUrl returns OAuth2 URL with Gmail scope and PKCE', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    const pkce = await auth.generateCodeVerifierAsync();
    const url = auth.generateAuthUrl({
      scopes: GMAIL_OAUTH_SCOPES,
      state: 'state-123',
      redirectUri: 'http://127.0.0.1:4010/oauth2callback',
      codeChallenge: pkce.codeChallenge,
    });

    expect(url).toContain('accounts.google.com');
    expect(auth.getOAuth2Client().generateAuthUrl).toHaveBeenCalledWith({
      access_type: 'offline',
      include_granted_scopes: true,
      prompt: 'consent',
      scope: GMAIL_OAUTH_SCOPES,
      state: 'state-123',
      login_hint: undefined,
      redirect_uri: 'http://127.0.0.1:4010/oauth2callback',
      code_challenge: 'pkce-challenge',
      code_challenge_method: 'S256',
    });
  });

  it('Scenario: exchangeCode uses code verifier and stores refresh token', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    await auth.exchangeCode('auth-code', {
      codeVerifier: 'pkce-verifier',
      redirectUri: 'http://127.0.0.1:4010/oauth2callback',
    });

    expect(auth.getOAuth2Client().getToken).toHaveBeenCalledWith({
      code: 'auth-code',
      codeVerifier: 'pkce-verifier',
      redirect_uri: 'http://127.0.0.1:4010/oauth2callback',
    });
    expect(auth.getOAuth2Client().setCredentials).toHaveBeenCalledWith({
      access_token: 'exchanged-token',
      refresh_token: 'exchanged-refresh',
      expiry_date: expect.any(Number),
    });
    expect(auth.getRefreshToken()).toBe('exchanged-refresh');
    expect(auth.getAccessToken()).toBe('exchanged-token');
  });

  it('Scenario: fetchProfile returns the authenticated Gmail address', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });
    await auth.connect({ access_token: 'gmail-token', refresh_token: 'gmail-refresh' });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        emailAddress: 'steven.obiajulu@gmail.com',
        historyId: '12345',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const profile = await auth.fetchProfile();

    expect(profile.emailAddress).toBe('steven.obiajulu@gmail.com');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      {
        headers: { Authorization: 'Bearer gmail-token' },
      },
    );
  });

  it('Scenario: disconnect revokes token', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    await auth.connect({ access_token: 'gmail-token', refresh_token: 'gmail-refresh' });
    await auth.disconnect();

    expect(auth.getAccessToken()).toBeUndefined();
    expect(auth.getRefreshToken()).toBeUndefined();
    expect(auth.isTokenExpired()).toBe(true);
    expect(auth.getOAuth2Client().revokeToken).toHaveBeenCalledWith('gmail-token');
  });

  it('Scenario: refresh without refresh_token throws', async () => {
    const auth = new GmailAuthManager({
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    await auth.connect({ access_token: 'gmail-token' });
    await expect(auth.refresh()).rejects.toThrow('No refresh token');
  });
});
