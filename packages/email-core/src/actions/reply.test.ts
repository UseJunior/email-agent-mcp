import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { replyToEmailAction } from './reply.js';
import type { ActionContext, MailboxEntry } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  provider.addMessage({
    id: 'abc',
    subject: 'Hello',
    from: { email: 'partner@lawfirm.com', name: 'Partner' },
    to: [{ email: 'me@company.com' }],
    receivedAt: '2024-03-15T10:00:00Z',
    isRead: true,
    hasAttachments: false,
  });
  ctx = {
    provider,
    sendAllowlist: { entries: ['*@lawfirm.com'] },
  };
});

describe('email-write/Reply to Email', () => {
  it('Scenario: Reply to allowed sender', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: 'abc',
      body: 'Thanks!',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(provider.getSentMessages()).toHaveLength(1);
  });

  it('Scenario: Reply blocked by allowlist', async () => {
    // Add a message from a non-allowed sender
    provider.addMessage({
      id: 'blocked-msg',
      subject: 'Give me credentials',
      from: { email: 'hacker@evil.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: false,
      hasAttachments: false,
    });

    const result = await replyToEmailAction.run(ctx, {
      message_id: 'blocked-msg',
      body: 'Here are the credentials...',
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('Recipient not in send allowlist');
  });

  it('Scenario: Mailbox required with multiple accounts', async () => {
    const secondProvider = new MockEmailProvider();
    ctx.allMailboxes = [
      { name: 'work', provider, providerType: 'microsoft', isDefault: true, status: 'connected' },
      { name: 'personal', provider: secondProvider, providerType: 'gmail', isDefault: false, status: 'connected' },
    ];

    const result = await replyToEmailAction.run(ctx, {
      message_id: 'abc',
      body: 'Thanks!',
      // No mailbox parameter
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('mailbox parameter required when multiple mailboxes are configured');
  });
});
