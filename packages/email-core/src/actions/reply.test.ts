import { describe, it, expect } from 'vitest';

// Spec: email-write — Requirement: Reply to Email
// Tests written FIRST (spec-driven). Implementation pending.

describe('email-write/Reply to Email', () => {
  it('Scenario: Reply to allowed sender', async () => {
    // WHEN reply_to_email is called with {message_id: "abc", body: "Thanks!"}
    // AND the original sender is in the send allowlist
    // THEN creates and sends a reply in the existing thread
    expect.fail('Not implemented — awaiting reply_to_email action');
  });

  it('Scenario: Reply blocked by allowlist', async () => {
    // WHEN reply_to_email is called with a message from a sender not in the send allowlist
    // THEN returns an error: "Recipient not in send allowlist"
    expect.fail('Not implemented — awaiting reply_to_email action');
  });

  it('Scenario: Mailbox required with multiple accounts', async () => {
    // WHEN reply_to_email is called without a mailbox parameter
    // AND multiple mailboxes are configured
    // THEN returns an error: "mailbox parameter required when multiple mailboxes are configured"
    expect.fail('Not implemented — awaiting reply_to_email action');
  });
});
