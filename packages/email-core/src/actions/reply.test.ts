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
    expect(result.error!.code).toBe('ALLOWLIST_BLOCKED');
    expect(result.error!.message).toContain('reply recipients not in send allowlist');
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

describe('email-write/Reply Allowlist — P0 regression (plan §2.0)', () => {
  it('Scenario: reply_all=true blocks on non-allowlisted auto-populated cc recipient', async () => {
    // Original thread: allowed sender + allowed recipient, but cc'd a non-allowlisted
    // outsider. Replying reply-all auto-populates all three into the reply draft.
    // The old code only checked original.from.email, letting this silently leak.
    const threadId = 'thread_with_evil_cc_123456';
    provider.addMessage({
      id: threadId,
      subject: 'Project update',
      from: { email: 'partner@lawfirm.com' },
      to: [{ email: 'me@company.com' }],
      cc: [{ email: 'outsider@evil.com' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const result = await replyToEmailAction.run(ctx, {
      message_id: threadId,
      body: 'I agree!',
      // reply_all defaults to true
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ALLOWLIST_BLOCKED');
    // The draft must have been created (provider populated recipients) and
    // then deleted by our send-path guard.
    expect(provider.getDrafts().size).toBe(0);
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: reply_all=false skips auto-populated cc and succeeds for sender-only', async () => {
    // Same thread as above — non-allowlisted outsider in cc — but reply_all=false
    // narrows to sender only, which IS allowlisted.
    const threadId = 'thread_with_evil_cc_222222';
    provider.addMessage({
      id: threadId,
      subject: 'Project update',
      from: { email: 'partner@lawfirm.com' },
      to: [{ email: 'me@company.com' }],
      cc: [{ email: 'outsider@evil.com' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const result = await replyToEmailAction.run(ctx, {
      message_id: threadId,
      body: 'Private response',
      reply_all: false,
    });

    expect(result.success).toBe(true);
    expect(provider.getSentMessages()).toHaveLength(1);
    const sent = provider.getSentMessages()[0];
    expect(sent.to.map(a => a.email)).toEqual(['partner@lawfirm.com']);
    // No cc should have been auto-populated
    expect(sent.cc ?? []).toHaveLength(0);
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

describe('email-write/Body Rendering', () => {
  it('Scenario: reply_to_email also renders', async () => {
    // Send path renders markdown
    const sendResult = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: '### Thanks\n\n**Here is the info:**\n- item 1\n- item 2',
    });

    expect(sendResult.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.body).toContain('### Thanks');
    expect(sent.bodyHtml).toContain('<h3>Thanks</h3>');
    expect(sent.bodyHtml).toContain('<li>item 1</li>');

    // Draft path also renders
    const draftResult = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: '## Draft reply\n\nWith **markdown**',
      draft: true,
    });

    expect(draftResult.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.bodyHtml).toContain('<h2>Draft reply</h2>');
    expect(draft.bodyHtml).toContain('<strong>markdown</strong>');
  });

  // Non-spec regression: format: text on reply
  it('reply format: text sends no bodyHtml', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: '### Not a header',
      format: 'text',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.body).toBe('### Not a header');
    expect(sent.bodyHtml).toBeUndefined();
  });
});
