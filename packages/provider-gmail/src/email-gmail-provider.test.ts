import { describe, it, expect } from 'vitest';

// Spec: provider-gmail — Requirements: Message Mapping, Label Mapping, NemoClaw Compatibility
// Tests written FIRST (spec-driven). Implementation pending.

describe('provider-gmail/Message Mapping', () => {
  it('Scenario: Gmail message to EmailMessage', async () => {
    // WHEN a Gmail message is fetched
    // THEN it is mapped to EmailMessage with threadId, labels, and standard fields
    expect.fail('Not implemented — awaiting GmailEmailProvider');
  });
});

describe('provider-gmail/Label Mapping', () => {
  it('Scenario: Label as folder', async () => {
    // WHEN list_emails is called with {folder: "junk"}
    // THEN the system queries messages with the SPAM label
    expect.fail('Not implemented — awaiting label mapping');
  });
});

describe('provider-gmail/NemoClaw Compatibility', () => {
  it('Scenario: NemoClaw egress', async () => {
    // WHEN running in NemoClaw
    // THEN gmail.googleapis.com, oauth2.googleapis.com, pubsub.googleapis.com are added to egress policy
    expect.fail('Not implemented — awaiting NemoClaw support');
  });
});
