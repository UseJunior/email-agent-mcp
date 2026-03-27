import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { getMailboxStatusAction } from './status.js';
import type { ActionContext } from './registry.js';

let ctx: ActionContext;

beforeEach(() => {
  ctx = {
    provider: new MockEmailProvider(),
    sendAllowlist: undefined, // No allowlist configured
  };
});

describe('mailbox-config/Mailbox Status', () => {
  it('Scenario: Status with warning', async () => {
    // WHEN get_mailbox_status is called and no send allowlist is configured
    const result = await getMailboxStatusAction.run(ctx, {});

    // THEN result includes warnings about outbound email being disabled
    expect(result.warnings).toContain(
      'Outbound email disabled — configure send allowlist to enable replies and sends',
    );
  });
});
