import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { createDraftAction, sendDraftAction, updateDraftAction } from './draft.js';
import { sendEmailAction } from './send.js';
import { ProviderError } from '../providers/provider.js';
import type { ActionContext } from './registry.js';
import type { EmailMessage } from '../types.js';

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

describe('email-write/Draft Address Parsing', () => {
  it('create_draft parses name-address strings on standard path', async () => {
    const result = await createDraftAction.run(ctx, {
      to: ['Alice <alice@allowed.com>'],
      cc: ['"Doe, Bob" <bob@allowed.com>'],
      subject: 'Hi',
      body: 'Hello',
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.to).toEqual([{ name: 'Alice', email: 'alice@allowed.com' }]);
    expect(draft.cc).toEqual([{ name: 'Doe, Bob', email: 'bob@allowed.com' }]);
  });

  it('create_draft parses name-address cc on reply-draft path', async () => {
    provider.addMessage({
      id: 'reply-orig',
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
      reply_to: 'reply-orig',
      cc: ['Jane <jane@allowed.com>'],
      body: 'Reply draft body',
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.cc).toEqual([{ name: 'Jane', email: 'jane@allowed.com' }]);
  });

  it('create_draft returns INVALID_ADDRESS for bad input', async () => {
    const result = await createDraftAction.run(ctx, {
      to: ['alice@allowed.com', 'not an email'],
      subject: 'Bad',
      body: 'Hi',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_ADDRESS');
    expect(result.error!.message).toContain('to[1]');
    expect(provider.getDrafts().size).toBe(0);
  });

  it('update_draft parses name-address strings', async () => {
    const created = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Original',
      body: 'Body',
    });
    expect(created.success).toBe(true);

    const updated = await updateDraftAction.run(ctx, {
      draft_id: created.draftId!,
      to: ['Alice Updated <alice@allowed.com>'],
      cc: ['Bob <bob@allowed.com>'],
    });

    expect(updated.success).toBe(true);
    const draft = provider.getDrafts().get(created.draftId!)!;
    expect(draft.to).toEqual([{ name: 'Alice Updated', email: 'alice@allowed.com' }]);
    expect(draft.cc).toEqual([{ name: 'Bob', email: 'bob@allowed.com' }]);
  });

  it('update_draft with cc: [] explicitly clears cc', async () => {
    const created = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      cc: ['bob@allowed.com'],
      subject: 'Original',
      body: 'Body',
    });
    expect(created.success).toBe(true);

    const updated = await updateDraftAction.run(ctx, {
      draft_id: created.draftId!,
      cc: [],
    });

    expect(updated.success).toBe(true);
    const draft = provider.getDrafts().get(created.draftId!)!;
    expect(draft.cc).toEqual([]);
  });

  it('update_draft returns INVALID_ADDRESS for bad input', async () => {
    const created = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Original',
      body: 'Body',
    });
    expect(created.success).toBe(true);

    const updated = await updateDraftAction.run(ctx, {
      draft_id: created.draftId!,
      cc: ['not an email'],
    });

    expect(updated.success).toBe(false);
    expect(updated.error!.code).toBe('INVALID_ADDRESS');
    expect(updated.error!.message).toContain('cc[0]');
  });
});

// Helper: build a stub EmailMessage shaped like a persisted draft.
function persistedDraft(overrides: Partial<EmailMessage>): EmailMessage {
  return {
    id: 'stub-draft-id',
    subject: 'stub',
    from: { email: 'me@company.com' },
    to: [],
    receivedAt: '2024-01-01T00:00:00Z',
    isRead: true,
    hasAttachments: false,
    ...overrides,
  };
}

describe('email-write/Draft Preview (issue #75)', () => {
  it('Scenario: Draft-creating tools return a persisted preview', async () => {
    // Spec scenario: every draft-creating tool returns a `preview` block
    // sourced from the persisted draft, and surfaces `previewError` when the
    // read-back fails. Concrete behaviors are exercised in the per-tool tests
    // below (create_draft / update_draft / reply_to_email / send_email).
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Spec',
      to: [{ email: 'alice@allowed.com' }],
      body: 'Body',
    }));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Spec',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.preview).toBeDefined();
    expect(result.preview!.subject).toBe('Spec');
    expect(result.previewError).toBeUndefined();
  });

  it('create_draft returns preview reflecting persisted draft (subject, to, cc, body, bodyHtml)', async () => {
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Hello',
      to: [{ email: 'alice@allowed.com' }],
      cc: [{ email: 'bob@allowed.com' }],
      body: '### Heading',
      bodyHtml: '<h3>Heading</h3>',
    }));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      cc: ['bob@allowed.com'],
      subject: 'Hello',
      body: '### Heading',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.preview).toBeDefined();
    expect(result.preview!.subject).toBe('Hello');
    expect(result.preview!.to).toEqual([{ email: 'alice@allowed.com' }]);
    expect(result.preview!.cc).toEqual([{ email: 'bob@allowed.com' }]);
    expect(result.preview!.body).toBe('### Heading');
    expect(result.preview!.bodyHtml).toBe('<h3>Heading</h3>');
  });

  it('create_draft preview reflects persisted state, not caller input (simulates #48 cc drop)', async () => {
    // Simulate Microsoft Graph dropping cc on createDraft: caller passes cc,
    // provider claims success, but the persisted draft has no cc. The preview
    // must show the persisted (empty) cc — this is the verification surface.
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Important',
      to: [{ email: 'alice@allowed.com' }],
      cc: undefined,
    }));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      cc: ['dropped@allowed.com'],
      subject: 'Important',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.preview).toBeDefined();
    expect(result.preview!.cc).toBeUndefined();
  });

  it('create_draft transient read-back failure: retry succeeds, preview present', async () => {
    // First call rejects (simulating a brief read-after-write window); the
    // helper retries after PREVIEW_RETRY_DELAY_MS and the real provider call
    // succeeds, so the agent ultimately sees a preview.
    vi.spyOn(provider, 'getMessage').mockRejectedValueOnce(new Error('read-back transient'));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Hello',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.preview).toBeDefined();
    expect(result.preview!.subject).toBe('Hello');
    expect(result.previewError).toBeUndefined();
  });

  it('create_draft persistent read-back failure: previewError surfaces, success unchanged', async () => {
    // Both calls reject — retry exhausted. previewError is structured so the
    // agent can distinguish "no preview returned" from "preview lookup failed".
    vi.spyOn(provider, 'getMessage').mockRejectedValue(new Error('read-back persistent'));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Hello',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.preview).toBeUndefined();
    expect(result.previewError).toBeDefined();
    expect(result.previewError!.code).toBe('PREVIEW_FETCH_FAILED');
    expect(result.previewError!.message).toBe('read-back persistent');
  });

  it('create_draft non-recoverable ProviderError: no retry, previewError carries provider code', async () => {
    const getMessageSpy = vi.spyOn(provider, 'getMessage')
      .mockRejectedValue(new ProviderError('INVALID_DRAFT_ID', 'no such draft', 'mock', false));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Hello',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.preview).toBeUndefined();
    expect(result.previewError!.code).toBe('INVALID_DRAFT_ID');
    expect(getMessageSpy).toHaveBeenCalledTimes(1); // no retry on non-recoverable
  });

  it('create_draft non-Error throw: previewError carries stringified value', async () => {
    vi.spyOn(provider, 'getMessage').mockRejectedValue('plain string failure');

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Hello',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.previewError!.code).toBe('PREVIEW_FETCH_FAILED');
    expect(result.previewError!.message).toBe('plain string failure');
  });

  it('create_draft sparse persisted message: preview omits absent fields cleanly', async () => {
    // Provider returned a draft with no body, bodyHtml, or cc — preview should
    // reflect that without crashing or fabricating defaults.
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Bare draft',
      to: [{ email: 'alice@allowed.com' }],
      cc: undefined,
      body: undefined,
      bodyHtml: undefined,
    }));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Bare draft',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.preview).toBeDefined();
    expect(result.preview!.subject).toBe('Bare draft');
    expect(result.preview!.to).toEqual([{ email: 'alice@allowed.com' }]);
    expect(result.preview!.cc).toBeUndefined();
    expect(result.preview!.body).toBeUndefined();
    expect(result.preview!.bodyHtml).toBeUndefined();
    expect(result.preview!.bodyTruncated).toBeUndefined();
    expect(result.preview!.bodyHtmlTruncated).toBeUndefined();
  });

  it('create_draft preview on reply-draft path (reply_to)', async () => {
    provider.addMessage({
      id: 'orig-msg',
      subject: 'Original',
      from: { email: 'partner@allowed.com' },
      to: [{ email: 'me@company.com' }],
      receivedAt: '2024-01-01T00:00:00Z',
      isRead: true,
      hasAttachments: false,
    });
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Re: Original',
      to: [{ email: 'partner@allowed.com' }],
      cc: [{ email: 'cc-1@allowed.com' }, { email: 'cc-2@allowed.com' }],
    }));

    const result = await createDraftAction.run(ctx, {
      to: 'partner@allowed.com',
      subject: 'Re: Original',
      reply_to: 'orig-msg',
      body: 'Reply',
    });

    expect(result.success).toBe(true);
    expect(result.preview!.cc).toEqual([
      { email: 'cc-1@allowed.com' },
      { email: 'cc-2@allowed.com' },
    ]);
  });

  it('update_draft returns preview reflecting persisted draft', async () => {
    const created = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Original',
      body: 'Body',
    });
    expect(created.success).toBe(true);

    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      id: created.draftId!,
      subject: 'Updated',
      to: [{ email: 'alice@allowed.com' }],
      body: 'New body',
    }));

    const result = await updateDraftAction.run(ctx, {
      draft_id: created.draftId!,
      subject: 'Updated',
      body: 'New body',
    });

    expect(result.success).toBe(true);
    expect(result.preview).toBeDefined();
    expect(result.preview!.subject).toBe('Updated');
    expect(result.preview!.body).toBe('New body');
  });

  it('update_draft preview surfaces persisted state when cc cannot be cleared (Graph quirk)', async () => {
    // Real-world Graph behavior: PATCH only includes ccRecipients when msg.cc
    // is truthy, so cc: [] silently fails to clear. The preview must show the
    // un-cleared cc — proving the verification surface catches this without
    // fixing the underlying bug.
    const created = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      cc: ['stale-cc@allowed.com'],
      subject: 'Original',
      body: 'Body',
    });
    expect(created.success).toBe(true);

    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      id: created.draftId!,
      subject: 'Original',
      to: [{ email: 'alice@allowed.com' }],
      cc: [{ email: 'stale-cc@allowed.com' }],
    }));

    const result = await updateDraftAction.run(ctx, {
      draft_id: created.draftId!,
      cc: [],
    });

    expect(result.success).toBe(true);
    expect(result.preview).toBeDefined();
    expect(result.preview!.cc).toEqual([{ email: 'stale-cc@allowed.com' }]);
  });

  it('update_draft persistent read-back failure: previewError surfaces, success unchanged', async () => {
    const created = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Original',
      body: 'Body',
    });
    expect(created.success).toBe(true);

    vi.spyOn(provider, 'getMessage').mockRejectedValue(new Error('read-back persistent'));

    const result = await updateDraftAction.run(ctx, {
      draft_id: created.draftId!,
      body: 'Updated',
    });

    expect(result.success).toBe(true);
    expect(result.preview).toBeUndefined();
    expect(result.previewError!.code).toBe('PREVIEW_FETCH_FAILED');
  });

  it('preview body is truncated past PREVIEW_BODY_LIMIT and signals truncation structurally', async () => {
    const huge = 'x'.repeat(64 * 1024);
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Big',
      to: [{ email: 'alice@allowed.com' }],
      body: huge,
      bodyHtml: huge,
    }));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Big',
      body: 'small input',
    });

    expect(result.success).toBe(true);
    // Both fields capped to the 32 KB MCP-response budget.
    expect(Buffer.byteLength(result.preview!.body!, 'utf-8')).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(result.preview!.bodyHtml!, 'utf-8')).toBeLessThanOrEqual(32 * 1024);
    // Structured truncation flag — agents should not need to grep a footer
    // string, and we deliberately do NOT append the misleading
    // "exceeded email size limits" notice (the persisted draft is unchanged).
    expect(result.preview!.bodyTruncated).toBe(true);
    expect(result.preview!.bodyHtmlTruncated).toBe(true);
    expect(result.preview!.body).not.toContain('exceeded email size limits');
    expect(result.preview!.bodyHtml).not.toContain('exceeded email size limits');
  });

  it('preview body within PREVIEW_BODY_LIMIT does not set bodyTruncated', async () => {
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Small',
      to: [{ email: 'alice@allowed.com' }],
      body: 'tiny',
    }));

    const result = await createDraftAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Small',
      body: 'tiny',
    });

    expect(result.success).toBe(true);
    expect(result.preview!.body).toBe('tiny');
    expect(result.preview!.bodyTruncated).toBeUndefined();
  });
});

describe('email-write/send_email Draft Preview (issue #75)', () => {
  it('send_email with draft: true returns preview reflecting persisted draft', async () => {
    // send_email's draft branch creates a draft via createDraft, the same
    // draft-creating contract as create_draft. The preview must be returned
    // for symmetry — agents should not need to choose between tools to get
    // verification.
    vi.spyOn(provider, 'getMessage').mockResolvedValueOnce(persistedDraft({
      subject: 'Send-as-draft',
      to: [{ email: 'alice@allowed.com' }],
      cc: [{ email: 'bob@allowed.com' }],
      body: 'Body',
    }));

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      cc: ['bob@allowed.com'],
      subject: 'Send-as-draft',
      body: 'Body',
      draft: true,
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.messageId).toBeUndefined();
    expect(provider.getSentMessages()).toHaveLength(0);
    expect(result.preview).toBeDefined();
    expect(result.preview!.subject).toBe('Send-as-draft');
    expect(result.preview!.cc).toEqual([{ email: 'bob@allowed.com' }]);
  });

  it('send_email with draft: true persistent read-back failure: previewError surfaces', async () => {
    vi.spyOn(provider, 'getMessage').mockRejectedValue(new Error('read-back persistent'));

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Send-as-draft',
      body: 'Body',
      draft: true,
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(result.preview).toBeUndefined();
    expect(result.previewError!.code).toBe('PREVIEW_FETCH_FAILED');
  });

  it('send_email send path (non-draft) returns no preview', async () => {
    // Preview is for draft-creating flows only. The send branch returns messageId.
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Live send',
      body: 'Body',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(result.preview).toBeUndefined();
    expect(result.previewError).toBeUndefined();
  });
});
