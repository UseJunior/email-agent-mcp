import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { replyToEmailAction } from './reply.js';
import type { ActionContext } from './registry.js';

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
    mailboxName: 'work',
    allMailboxes: [
      { name: 'work', emailAddress: 'me@company.com', provider, providerType: 'microsoft', isDefault: true, status: 'connected' },
    ],
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

describe('email-write/Reply Allowlist Coverage', () => {
  it('Scenario: reply_all blocks non-allowlisted thread cc recipients', async () => {
    const replySpy = vi.spyOn(provider, 'replyToMessage');
    const ccMsgId = 'reply_all_cc_1234567890';
    provider.addMessage({
      id: ccMsgId,
      subject: 'Shared thread',
      from: { email: 'partner@lawfirm.com', name: 'Partner' },
      to: [{ email: 'me@company.com' }],
      cc: [{ email: 'external@example.com', name: 'External' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const input = replyToEmailAction.input.parse({
      message_id: ccMsgId,
      body: 'Reply all',
    });

    const result = await replyToEmailAction.run(ctx, input);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ALLOWLIST_BLOCKED');
    expect(result.error!.message).toContain('Recipient not in send allowlist');
    expect(replySpy).not.toHaveBeenCalled();
  });

  it('Scenario: reply_all false ignores non-allowlisted thread cc recipients', async () => {
    const replySpy = vi.spyOn(provider, 'replyToMessage');
    const ccMsgId = 'sender_only_cc_1234567890';
    provider.addMessage({
      id: ccMsgId,
      subject: 'Shared thread',
      from: { email: 'partner@lawfirm.com', name: 'Partner' },
      to: [{ email: 'me@company.com' }],
      cc: [{ email: 'external@example.com', name: 'External' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const input = replyToEmailAction.input.parse({
      message_id: ccMsgId,
      body: 'Sender only',
      reply_all: false,
    });

    const result = await replyToEmailAction.run(ctx, input);

    expect(result.success).toBe(true);
    expect(replySpy).toHaveBeenCalledWith(
      ccMsgId,
      expect.any(String),
      expect.objectContaining({ replyAll: false }),
    );
  });

  it('Scenario: explicit cc recipients are also gated by allowlist', async () => {
    const replySpy = vi.spyOn(provider, 'replyToMessage');

    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Loop in external',
      reply_all: false,
      cc: ['external@example.com'],
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ALLOWLIST_BLOCKED');
    expect(result.error!.message).toContain('Recipient not in send allowlist');
    expect(replySpy).not.toHaveBeenCalled();
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

describe('email-write/Reply All Toggle', () => {
  // Note: Zod defaults are applied at parse() time, not in run(). The MCP server
  // calls action.input.parse() before action.run(), so production callers see
  // the default. These tests parse first to mirror that real flow.

  it('Scenario: reply_all defaults to true and propagates to provider', async () => {
    const replySpy = vi.spyOn(provider, 'replyToMessage');

    const input = replyToEmailAction.input.parse({
      message_id: VALID_MSG_ID,
      body: 'Thanks!',
    });
    expect(input.reply_all).toBe(true);

    const result = await replyToEmailAction.run(ctx, input);

    expect(result.success).toBe(true);
    expect(replySpy).toHaveBeenCalledWith(
      VALID_MSG_ID,
      expect.any(String),
      expect.objectContaining({ replyAll: true }),
    );
  });

  it('Scenario: reply_all: false propagates to provider on send path', async () => {
    const replySpy = vi.spyOn(provider, 'replyToMessage');

    const input = replyToEmailAction.input.parse({
      message_id: VALID_MSG_ID,
      body: 'Sender only',
      reply_all: false,
    });

    const result = await replyToEmailAction.run(ctx, input);

    expect(result.success).toBe(true);
    expect(replySpy).toHaveBeenCalledWith(
      VALID_MSG_ID,
      expect.any(String),
      expect.objectContaining({ replyAll: false }),
    );
  });

  it('Scenario: reply_all: false propagates to provider on draft path', async () => {
    const draftSpy = vi.spyOn(provider, 'createReplyDraft');

    const input = replyToEmailAction.input.parse({
      message_id: VALID_MSG_ID,
      body: 'Draft reply',
      draft: true,
      reply_all: false,
    });

    const result = await replyToEmailAction.run(ctx, input);

    expect(result.success).toBe(true);
    expect(draftSpy).toHaveBeenCalledWith(
      VALID_MSG_ID,
      expect.any(String),
      expect.objectContaining({ replyAll: false }),
    );
  });

  it('Scenario: reply_all defaults to true on draft path', async () => {
    const draftSpy = vi.spyOn(provider, 'createReplyDraft');

    const input = replyToEmailAction.input.parse({
      message_id: VALID_MSG_ID,
      body: 'Draft reply',
      draft: true,
    });
    expect(input.reply_all).toBe(true);

    await replyToEmailAction.run(ctx, input);

    expect(draftSpy).toHaveBeenCalledWith(
      VALID_MSG_ID,
      expect.any(String),
      expect.objectContaining({ replyAll: true }),
    );
  });
});

describe('email-write/Reply CC Address Parsing', () => {
  it('Scenario: name-address cc string is parsed into {name, email} on send path', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Looping in counsel',
      reply_all: false,
      cc: ['Jane Doe <jane@lawfirm.com>'],
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.cc).toEqual([{ name: 'Jane Doe', email: 'jane@lawfirm.com' }]);
  });

  it('Scenario: name-address cc string is parsed on draft path', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Draft with cc',
      draft: true,
      cc: ['"Doe, Jane" <jane@lawfirm.com>'],
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.cc).toEqual([{ name: 'Doe, Jane', email: 'jane@lawfirm.com' }]);
  });

  it('Scenario: invalid cc address returns INVALID_ADDRESS with field/index', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Bad cc',
      cc: ['jane@lawfirm.com', 'not an email'],
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_ADDRESS');
    expect(result.error!.message).toContain('cc[1]');
    expect(result.error!.message).toContain('not an email');
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: parsed cc email is what feeds the allowlist (no false reject for name-address form)', async () => {
    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Looping in counsel',
      reply_all: false,
      cc: ['Jane <jane@lawfirm.com>'],
    });

    // sendAllowlist is *@lawfirm.com — parsed cc email matches; should pass.
    expect(result.success).toBe(true);
  });
});
