import { describe, it, expect } from 'vitest';

// Spec: mailbox-config — Requirements: Configure Mailbox, Default Mailbox,
//       Remove Mailbox, List Mailboxes, Provider Discovery
// Tests written FIRST (spec-driven). Implementation pending.

describe('mailbox-config/Configure Mailbox', () => {
  it('Scenario: Add work mailbox', async () => {
    // WHEN configure_mailbox is called with {name: "work", provider: "microsoft", credentials: {...}, default: true}
    // THEN connects to the Microsoft Graph API and marks "work" as the default mailbox
    expect.fail('Not implemented — awaiting configure_mailbox action');
  });
});

describe('mailbox-config/Default Mailbox', () => {
  it('Scenario: Single mailbox auto-default', async () => {
    // WHEN only one mailbox ("personal") is configured
    // THEN "personal" is automatically the default for all actions
    expect.fail('Not implemented — awaiting default mailbox logic');
  });
});

describe('mailbox-config/Remove Mailbox', () => {
  it('Scenario: Remove old account', async () => {
    // WHEN remove_mailbox is called with {name: "old-account"}
    // THEN disconnects and removes the mailbox configuration
    expect.fail('Not implemented — awaiting remove_mailbox action');
  });
});

describe('mailbox-config/List Mailboxes', () => {
  it('Scenario: List all mailboxes', async () => {
    // WHEN list_mailboxes is called
    // THEN returns [{name: "work", provider: "microsoft", isDefault: true, status: "connected"}, ...]
    expect.fail('Not implemented — awaiting list_mailboxes action');
  });
});

describe('mailbox-config/Provider Discovery', () => {
  it('Scenario: Provider not installed', async () => {
    // WHEN configure_mailbox is called with {provider: "gmail"} but @usejunior/provider-gmail is not installed
    // THEN returns: "Provider 'gmail' not available. Install: npm install @usejunior/provider-gmail"
    expect.fail('Not implemented — awaiting provider discovery');
  });
});
