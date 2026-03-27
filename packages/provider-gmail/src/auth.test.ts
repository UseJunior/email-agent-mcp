import { describe, it, expect } from 'vitest';
import { GmailAuthManager } from './auth.js';

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

    // Refresh works
    await auth.refresh();
    expect(auth.getAccessToken()).toBeDefined();
    expect(auth.isTokenExpired()).toBe(false);
  });
});
