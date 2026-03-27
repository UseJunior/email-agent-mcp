import { describe, it, expect } from 'vitest';

// Spec: provider-interface — All requirements
// Tests written FIRST (spec-driven). Implementation pending.

describe('provider-interface/Capability Interfaces', () => {
  it('Scenario: Provider supports read and send', async () => {
    // WHEN a provider implements EmailReader and EmailSender
    // THEN read and write actions work; subscribe actions return "not supported by this provider"
    expect.fail('Not implemented — awaiting capability interface');
  });
});

describe('provider-interface/Provider Registration', () => {
  it('Scenario: Dynamic discovery', async () => {
    // WHEN the MCP server starts
    // THEN it discovers installed provider packages and makes them available for configure_mailbox
    expect.fail('Not implemented — awaiting provider registration');
  });
});

describe('provider-interface/Error Normalization', () => {
  it('Scenario: Graph 429 normalized', async () => {
    // WHEN Graph API returns 429 Too Many Requests
    // THEN error is normalized to {code: "RATE_LIMITED", message: "...", provider: "microsoft", recoverable: true, retryAfter: 30}
    expect.fail('Not implemented — awaiting error normalization');
  });
});

describe('provider-interface/Rate Limit Handling', () => {
  it('Scenario: Exponential backoff', async () => {
    // WHEN a provider returns 429
    // THEN retries with exponential backoff (1s, 2s, 4s) up to a configurable max
    expect.fail('Not implemented — awaiting rate limit handling');
  });
});

describe('provider-interface/Authentication Lifecycle', () => {
  it('Scenario: Token refresh', async () => {
    // WHEN an access token expires during an operation
    // THEN refreshes the token using the stored refresh token and retries the operation
    expect.fail('Not implemented — awaiting auth lifecycle');
  });
});
