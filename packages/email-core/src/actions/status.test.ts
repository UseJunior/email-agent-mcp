import { describe, it, expect } from 'vitest';

// Spec: mailbox-config — Requirement: Mailbox Status
// Tests written FIRST (spec-driven). Implementation pending.

describe('mailbox-config/Mailbox Status', () => {
  it('Scenario: Status with warning', async () => {
    // WHEN get_mailbox_status is called and no send allowlist is configured
    // THEN result includes warnings: ["Outbound email disabled — configure send allowlist to enable replies and sends"]
    expect.fail('Not implemented — awaiting get_mailbox_status action');
  });
});
