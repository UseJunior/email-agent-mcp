import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { createDraftAction, sendDraftAction, updateDraftAction } from './draft.js';
import { ATTACHMENT_DIR_ENV } from '../content/attachment-loader.js';
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

  it('Scenario: reply_to with no to/subject succeeds (relaxed validation)', async () => {
    provider.addMessage({
      id: 'orig-no-fields',
      subject: 'Original thread',
      from: { email: 'partner@allowed.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const result = await createDraftAction.run(ctx, {
      reply_to: 'orig-no-fields',
      body: 'Just the body',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
  });

  it('Scenario: frontmatter reply_all=false overrides default', async () => {
    provider.addMessage({
      id: 'orig-fm-replyall',
      subject: 'Original',
      from: { email: 'partner@allowed.com' },
      to: [{ email: 'me@company.com' }],
      cc: [{ email: 'other@allowed.com' }],
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: true,
      hasAttachments: false,
    });
    await writeFile(join(testDir, 'fm-reply.md'), `---
reply_to: orig-fm-replyall
reply_all: false
to: partner@allowed.com
---
Private response`);

    const result = await createDraftAction.run(ctx, {
      body_file: 'fm-reply.md',
    });

    expect(result.success).toBe(true);
    // Mock's createReplyDraft gets replyAll=false and should NOT populate
    // cc from original.to + original.cc
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.cc ?? []).toHaveLength(0);
  });

  it('Scenario: reply_to with reply_all=false and no to fails with MISSING_FIELD', async () => {
    provider.addMessage({
      id: 'orig-narrow',
      subject: 'Narrow me',
      from: { email: 'partner@allowed.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const result = await createDraftAction.run(ctx, {
      reply_to: 'orig-narrow',
      reply_all: false,
      body: 'Private',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('MISSING_FIELD');
    expect(result.error!.message).toContain('reply_all=false');
  });

  it('Scenario: createDraft preserves cc (regression for dropped cc bug)', async () => {
    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      cc: ['bob@allowed.com', 'carol@allowed.com'],
      subject: 'With CC',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.cc?.map(a => a.email)).toEqual(['bob@allowed.com', 'carol@allowed.com']);
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

describe('email-write/Body Rendering', () => {
  it('Scenario: create_draft and update_draft also render', async () => {
    // create_draft renders markdown
    const created = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Markdown Draft',
      body: '### Hi\n\n**bold**',
    });

    expect(created.success).toBe(true);
    const createdDraft = provider.getDrafts().get(created.draftId!)!;
    expect(createdDraft.body).toContain('### Hi');
    expect(createdDraft.bodyHtml).toContain('<h3>Hi</h3>');
    expect(createdDraft.bodyHtml).toContain('<strong>bold</strong>');

    // update_draft renders markdown
    const updated = await updateDraftAction.run(ctx, {
      draft_id: created.draftId!,
      body: '## Updated',
    });

    expect(updated.success).toBe(true);
    const updatedDraft = provider.getDrafts().get(created.draftId!)!;
    expect(updatedDraft.body).toContain('## Updated');
    expect(updatedDraft.bodyHtml).toContain('<h2>Updated</h2>');
  });

  // Non-spec regression: format: text also works on drafts
  it('create_draft format: text sends no bodyHtml', async () => {
    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Plain Draft',
      body: '### Not a header',
      format: 'text',
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.body).toBe('### Not a header');
    expect(draft.bodyHtml).toBeUndefined();
  });
});

describe('email-write/Create Draft — attachments (plan §2.1)', () => {
  let attachDir: string;
  const savedEnv = process.env[ATTACHMENT_DIR_ENV];

  beforeEach(async () => {
    attachDir = await mkdtemp(join(tmpdir(), 'draft-attach-test-'));
    process.env[ATTACHMENT_DIR_ENV] = attachDir;
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      delete process.env[ATTACHMENT_DIR_ENV];
    } else {
      process.env[ATTACHMENT_DIR_ENV] = savedEnv;
    }
    await rm(attachDir, { recursive: true, force: true });
  });

  it('Scenario: create_draft with one attachment stores it on the mock draft', async () => {
    await writeFile(join(attachDir, 'report.pdf'), 'pdf bytes');

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'With attachment',
      body: 'See attached',
      attachments: ['report.pdf'],
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments![0]!.filename).toBe('report.pdf');
    expect(draft.attachments![0]!.content.toString('utf-8')).toBe('pdf bytes');
  });

  it('Scenario: create_draft with oversized attachment fails', async () => {
    await writeFile(join(attachDir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 1, 0x41));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Too big',
      body: 'nope',
      attachments: ['big.bin'],
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(provider.getDrafts().size).toBe(0);
  });

  it('Scenario: create_draft with attachment but env var unset fails', async () => {
    delete process.env[ATTACHMENT_DIR_ENV];

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'No dir',
      body: 'nope',
      attachments: ['report.pdf'],
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ATTACHMENT_DIR_NOT_CONFIGURED');
  });

  it('Scenario: create_draft with frontmatter + param attachments merges both', async () => {
    await writeFile(join(attachDir, 'from-fm.txt'), 'fm');
    await writeFile(join(attachDir, 'from-param.txt'), 'param');
    // Frontmatter attachments are a comma-separated list
    await writeFile(join(testDir, 'draft.md'), `---
to: alice@allowed.com
subject: Merged
attachments: from-fm.txt
---
Body`);

    const result = await createDraftAction.run(ctx, {
      body_file: 'draft.md',
      attachments: ['from-param.txt'],
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.attachments).toHaveLength(2);
    expect(draft.attachments!.map(a => a.filename)).toEqual(['from-fm.txt', 'from-param.txt']);
  });

  it('Scenario: two same-basename attachments get disambiguated filenames', async () => {
    await mkdir(join(attachDir, 'a'));
    await mkdir(join(attachDir, 'b'));
    await writeFile(join(attachDir, 'a', 'report.pdf'), 'first');
    await writeFile(join(attachDir, 'b', 'report.pdf'), 'second');

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Two reports',
      body: 'See attached',
      attachments: ['a/report.pdf', 'b/report.pdf'],
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.attachments!.map(a => a.filename)).toEqual(['report.pdf', 'report (2).pdf']);
  });

  it('Scenario: reply draft attachments flow through to mock (via opts.attachments)', async () => {
    provider.addMessage({
      id: 'thread-att',
      subject: 'Thread',
      from: { email: 'partner@allowed.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: true,
      hasAttachments: false,
    });
    await writeFile(join(attachDir, 'doc.pdf'), 'bytes');

    const result = await createDraftAction.run(ctx, {
      reply_to: 'thread-att',
      body: 'Response',
      attachments: ['doc.pdf'],
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments![0]!.filename).toBe('doc.pdf');
  });
});

describe('email-write/Create Draft — update_source_frontmatter (plan §2.3)', () => {
  it('Scenario: standard draft with update_source_frontmatter=true writes draft_id + draft_link', async () => {
    const src = join(testDir, 'source.md');
    await writeFile(src, `---
to: alice@allowed.com
subject: Write back
---
Body`);

    const result = await createDraftAction.run(ctx, {
      body_file: 'source.md',
      update_source_frontmatter: true,
    });

    expect(result.success).toBe(true);
    const updated = await import('node:fs/promises').then(m => m.readFile(src, 'utf-8'));
    expect(updated).toContain(`draft_id: ${result.draftId}`);
    expect(updated).toContain(`draft_link: https://outlook.office.com/mail/deeplink/compose?ItemID=${encodeURIComponent(result.draftId!)}`);
    // Existing keys preserved
    expect(updated).toContain('to: alice@allowed.com');
    expect(updated).toContain('Body');
  });

  it('Scenario: reply draft writes draft_reply_id + draft_reply_link (reply-specific keys)', async () => {
    provider.addMessage({
      id: 'thread-writeback',
      subject: 'Original',
      from: { email: 'partner@allowed.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const src = join(testDir, 'reply.md');
    await writeFile(src, `---
reply_to: thread-writeback
---
Reply body`);

    const result = await createDraftAction.run(ctx, {
      body_file: 'reply.md',
      update_source_frontmatter: true,
    });

    expect(result.success).toBe(true);
    const updated = await import('node:fs/promises').then(m => m.readFile(src, 'utf-8'));
    expect(updated).toContain(`draft_reply_id: ${result.draftId}`);
    expect(updated).toContain('draft_reply_link: https://outlook.office.com');
    expect(updated).not.toContain('draft_id:');
  });

  it('Scenario: default (update_source_frontmatter=false) leaves source byte-exact', async () => {
    const src = join(testDir, 'unchanged.md');
    const original = `---
to: alice@allowed.com
subject: Leave me alone
---
Body here
`;
    await writeFile(src, original);

    const result = await createDraftAction.run(ctx, {
      body_file: 'unchanged.md',
    });

    expect(result.success).toBe(true);
    const { readFile: rf } = await import('node:fs/promises');
    const after = await rf(src, 'utf-8');
    expect(after).toBe(original);
  });

  it('Scenario: write failure does not abort the draft (silent fail)', async () => {
    const src = join(testDir, 'readonly.md');
    await writeFile(src, `---
to: alice@allowed.com
subject: Silent fail
---
Body`);
    const { chmod } = await import('node:fs/promises');
    await chmod(src, 0o444);

    try {
      const result = await createDraftAction.run(ctx, {
        body_file: 'readonly.md',
        update_source_frontmatter: true,
      });
      // Draft still succeeds even though the frontmatter patch failed
      expect(result.success).toBe(true);
      expect(result.draftId).toBeDefined();
    } finally {
      await chmod(src, 0o644).catch(() => {});
    }
  });
});
