import { describe, it, expect } from 'vitest';

// Spec: provider-microsoft — Requirements: Delegated OAuth Authentication, Client Credentials Authentication
// Tests written FIRST (spec-driven). Implementation pending.

describe('provider-microsoft/Delegated OAuth Authentication', () => {
  it('Scenario: Device code flow', async () => {
    // WHEN configure_mailbox is called with {provider: "microsoft", auth: "delegated"}
    // THEN initiates device code flow and prompts user to authenticate in a browser
    expect.fail('Not implemented — awaiting delegated OAuth');
  });

  it('Scenario: Refresh token persistence', async () => {
    // WHEN the MCP server restarts
    // THEN loads encrypted refresh tokens from config directory and resumes without re-auth
    expect.fail('Not implemented — awaiting token persistence');
  });
});

describe('provider-microsoft/Client Credentials Authentication', () => {
  it('Scenario: Client credentials', async () => {
    // WHEN configure_mailbox is called with {provider: "microsoft", auth: "client_credentials", clientId, clientSecret, tenantId}
    // THEN authenticates via ClientSecretCredential
    expect.fail('Not implemented — awaiting client credentials auth');
  });
});
