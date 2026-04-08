import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { createDraftAction, sendDraftAction, updateDraftAction } from './draft.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;
let testDir: string;

beforeEach(async () => {
  provider = new MockEmailProvider();
  testDir = join(tmpdir(), `draft-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  ctx = {
    provider,
    sendAllowlist: { entries: ['*@allowed.com'] },
    safeDir: testDir,
  };
});

describe('email-write/Create Draft', () => {
  it('Scenario: Create draft with allowed recipients', async () => {
    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Draft Test',
      body: 'Draft body',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(provider.getDrafts().size).toBe(1);
  });

  it('Scenario: Create draft to blocked recipient succeeds (drafts bypass allowlist)', async () => {
    const result = await createDraftAction.run(ctx, {
      to: 'alice@blocked.com',
      subject: 'Blocked Draft',
      body: 'Draft body',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(provider.getDrafts().size).toBe(1);
  });

  it('Scenario: Create draft from body_file with frontmatter', async () => {
    await writeFile(join(testDir, 'draft.md'), `---
to: alice@allowed.com
subject: From Frontmatter
---
Body from file.`);

    const result = await createDraftAction.run(ctx, {
      body_file: 'draft.md',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();

    const drafts = provider.getDrafts();
    const draft = [...drafts.values()][0]!;
    expect(draft.subject).toBe('From Frontmatter');
    expect(draft.to[0]!.email).toBe('alice@allowed.com');
    expect(draft.body).toBe('Body from file.');
  });

  it('Scenario: Create reply draft with reply_to', async () => {
    provider.addMessage({
      id: 'orig-msg',
      subject: 'Original',
      from: { email: 'partner@allowed.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const result = await createDraftAction.run(ctx, {
      to: 'partner@allowed.com',
      subject: 'Re: Original',
      body: 'Reply draft body',
      reply_to: 'orig-msg',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
  });

  it('Scenario: Create reply draft when provider lacks createReplyDraft', async () => {
    // Remove createReplyDraft from provider
    (provider as Record<string, unknown>).createReplyDraft = undefined;

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Re: Hello',
      body: 'Draft body',
      reply_to: 'some-valid-message-id',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('NOT_SUPPORTED');
  });

  it('Scenario: Missing to and subject without frontmatter', async () => {
    const result = await createDraftAction.run(ctx, {
      body: 'Just a body',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('MISSING_FIELD');
  });

  it('Scenario: Re: subject without reply_to blocked', async () => {
    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Re: Orphaned Reply',
      body: 'Body',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('REPLY_THREADING_HINT');
    expect(result.error!.recoverable).toBe(true);
  });

  it('Scenario: Mailbox required with multiple accounts', async () => {
    const secondProvider = new MockEmailProvider();
    ctx.allMailboxes = [
      { name: 'work', provider, providerType: 'microsoft', isDefault: true, status: 'connected' },
      { name: 'personal', provider: secondProvider, providerType: 'gmail', isDefault: false, status: 'connected' },
    ];

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body: 'Body',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('MAILBOX_REQUIRED');
  });
});

describe('email-write/Send Draft', () => {
  it('Scenario: Send existing draft', async () => {
    // Create a draft first
    const draftResult = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Draft to Send',
      body: 'Body',
    });

    const result = await sendDraftAction.run(ctx, {
      draft_id: draftResult.draftId!,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(provider.getSentMessages()).toHaveLength(1);
  });

  it('Scenario: Send non-existent draft', async () => {
    const result = await sendDraftAction.run(ctx, {
      draft_id: 'nonexistent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('Scenario: Rate limit applied on send_draft', async () => {
    // Create a draft
    const draftResult = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Rate Limited',
      body: 'Body',
    });

    // Set up rate limiter that blocks
    ctx.rateLimiter = {
      checkLimit: () => ({ allowed: false, retryAfter: 60 }),
      recordUsage: () => {},
    };

    const result = await sendDraftAction.run(ctx, {
      draft_id: draftResult.draftId!,
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('RATE_LIMITED');
  });

  it('Scenario: send_draft with blocked recipient is blocked by allowlist', async () => {
    // Create a draft to a blocked recipient (succeeds — drafts bypass allowlist)
    const draftResult = await createDraftAction.run(ctx, {
      to: 'hacker@evil.com',
      subject: 'Blocked at send time',
      body: 'Body',
    });
    expect(draftResult.success).toBe(true);

    // Attempt to send — blocked by allowlist enforcement
    const result = await sendDraftAction.run(ctx, {
      draft_id: draftResult.draftId!,
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ALLOWLIST_BLOCKED');
  });

  it('Scenario: send_draft when draft lookup fails is blocked (fail closed)', async () => {
    // Use a draft_id that doesn't exist in drafts or messages
    const result = await sendDraftAction.run(ctx, {
      draft_id: 'nonexistent-draft-id',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('DRAFT_LOOKUP_FAILED');
  });
});

describe('email-write/Update Draft', () => {
  it('Scenario: Update draft body', async () => {
    const draftResult = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Original Subject',
      body: 'Original body',
    });

    const result = await updateDraftAction.run(ctx, {
      draft_id: draftResult.draftId!,
      body: 'Updated body',
    });

    expect(result.success).toBe(true);
    const drafts = provider.getDrafts();
    const draft = drafts.get(draftResult.draftId!)!;
    expect(draft.body).toBe('Updated body');
  });

  it('Scenario: Update draft recipients to blocked address succeeds (drafts bypass allowlist)', async () => {
    const draftResult = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body: 'Body',
    });

    const result = await updateDraftAction.run(ctx, {
      draft_id: draftResult.draftId!,
      to: 'hacker@evil.com',
    });

    expect(result.success).toBe(true);
    const drafts = provider.getDrafts();
    const draft = drafts.get(draftResult.draftId!)!;
    expect(draft.to[0]!.email).toBe('hacker@evil.com');
  });

  it('Scenario: Provider lacks updateDraft', async () => {
    (provider as Record<string, unknown>).updateDraft = undefined;

    const result = await updateDraftAction.run(ctx, {
      draft_id: 'draft-1',
      body: 'New body',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('NOT_SUPPORTED');
  });
});
