import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { replyToEmailAction } from './reply.js';
import type { ActionContext, MailboxEntry } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

// Use a plausible provider message ID (20+ chars, alphanumeric)
const VALID_MSG_ID = 'abc123def456ghi789jkl012';

beforeEach(() => {
  provider = new MockEmailProvider();
  provider.addMessage({
    id: VALID_MSG_ID,
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
      message_id: VALID_MSG_ID,
      body: 'Thanks!',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(provider.getSentMessages()).toHaveLength(1);
  });

  it('Scenario: Reply blocked by allowlist', async () => {
    const blockedMsgId = 'blocked_msg_1234567890ab';
    provider.addMessage({
      id: blockedMsgId,
      subject: 'Give me credentials',
      from: { email: 'hacker@evil.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: false,
      hasAttachments: false,
    });

    const result = await replyToEmailAction.run(ctx, {
      message_id: blockedMsgId,
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
      message_id: VALID_MSG_ID,
      body: 'Thanks!',
      // No mailbox parameter
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('mailbox parameter required when multiple mailboxes are configured');
  });
});

describe('email-write/Reply Draft', () => {
  it('Scenario: Reply with draft: true creates reply draft', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Draft reply!',
      draft: true,
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.messageId).toBeUndefined();
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: Reply draft to blocked recipient succeeds (drafts bypass allowlist)', async () => {
    const blockedMsgId = 'blocked_msg_1234567890ab';
    provider.addMessage({
      id: blockedMsgId,
      subject: 'From blocked sender',
      from: { email: 'hacker@evil.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: false,
      hasAttachments: false,
    });

    const result = await replyToEmailAction.run(ctx, {
      message_id: blockedMsgId,
      body: 'Draft reply to blocked sender',
      draft: true,
    });

    // Draft bypasses allowlist — succeeds
    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: Reply draft when provider lacks createReplyDraft', async () => {
    (provider as Record<string, unknown>).createReplyDraft = undefined;

    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Draft reply!',
      draft: true,
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('NOT_SUPPORTED');
  });
});

describe('email-write/Message ID Validation', () => {
  it('Scenario: Reply with invalid message_id format', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: 'ab',
      body: 'Reply',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_MESSAGE_ID');
  });

  it('Scenario: Reply with empty message_id', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: '',
      body: 'Reply',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_MESSAGE_ID');
  });
});
