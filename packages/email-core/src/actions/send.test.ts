import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFile, mkdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { sendEmailAction } from './send.js';
import { ProviderError } from '../providers/provider.js';
import { SendLedger, resetDefaultSendLedger } from '../security/send-ledger.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;
let testDir: string;

beforeEach(async () => {
  provider = new MockEmailProvider();
  testDir = join(tmpdir(), `email-agent-mcp-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  ctx = {
    provider,
    // A fresh ledger per test. Without it the process-default ledger is shared
    // across cases, and two tests sending the same message collide as
    // duplicates — which is the guard working, not a test bug.
    sendLedger: new SendLedger(),
    sendAllowlist: { entries: ['*@allowed.com'] },
    safeDir: testDir,
  };
});

describe('email-write/Send Email', () => {
  it('Scenario: Send to allowed domain', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeDefined();
    expect(provider.getSentMessages()).toHaveLength(1);
  });

  it('Scenario: Send blocked by empty allowlist', async () => {
    ctx.sendAllowlist = undefined;

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Hi',
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('Send allowlist not configured');
    expect(result.error!.message).toContain('all outbound email is disabled');
  });
});

describe('email-write/Body File Composition', () => {
  it('Scenario: Compose from markdown file', async () => {
    await writeFile(join(testDir, 'draft.md'), '# Hello\n\nThis is the body.');

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Draft Test',
      body_file: 'draft.md',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('# Hello');
  });

  it('Scenario: Path traversal rejected', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body_file: '../../../etc/passwd',
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('body_file must be within the working directory');
  });

  it('Scenario: Binary file rejected', async () => {
    // Write a file with binary content (null bytes) but text extension
    await writeFile(join(testDir, 'fake.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body_file: 'fake.md',
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('body_file must be a text file');
  });

  it('Scenario: Symlink escape rejected', async () => {
    const outsideFile = join(tmpdir(), `outside-${Date.now()}.txt`);
    await writeFile(outsideFile, 'secret data');
    const linkPath = join(testDir, 'escape.md');
    try {
      await symlink(outsideFile, linkPath);
    } catch {
      // Symlinks may not be supported — skip gracefully
      return;
    }

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body_file: 'escape.md',
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('body_file symlink targets outside working directory');

    await rm(outsideFile, { force: true });
  });

  it('Scenario: File not found', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body_file: 'nonexistent.md',
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('body_file not found');
  });

  it('Scenario: Configured safe directory', async () => {
    const safeDir = join(tmpdir(), `safe-dir-${Date.now()}`);
    await mkdir(safeDir, { recursive: true });
    await writeFile(join(safeDir, 'safe-draft.md'), 'Safe body content');

    ctx.safeDir = safeDir;
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body_file: 'safe-draft.md',
    });

    expect(result.success).toBe(true);
    expect(provider.getSentMessages()[0]!.body).toBe('Safe body content');
  });

  // Issue #105 — operator-allowlisted roots, so a body file (or attachment)
  // outside the working directory need not be copied into a git working tree.
  it('Scenario: Configured additional root', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'allowed-root-'));
    await writeFile(join(extraDir, 'outside-draft.md'), 'Body from an allowed root');

    const result = await sendEmailAction.run(
      { ...ctx, allowedDirs: [extraDir] },
      {
        to: 'alice@allowed.com',
        subject: 'Test',
        body_file: join(extraDir, 'outside-draft.md'),
      },
    );

    expect(result.success).toBe(true);
    expect(provider.getSentMessages()[0]!.body).toBe('Body from an allowed root');

    await rm(extraDir, { recursive: true, force: true });
  });

  it('Scenario: Allowlisted root is itself a symlink', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'real-root-'));
    await writeFile(join(realRoot, 'linked-draft.md'), 'Body behind a symlinked root');
    const linkedRoot = join(tmpdir(), `linked-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      await symlink(realRoot, linkedRoot);
    } catch {
      return; // symlinks may not be supported
    }

    const result = await sendEmailAction.run(
      { ...ctx, allowedDirs: [linkedRoot] },
      {
        to: 'alice@allowed.com',
        subject: 'Test',
        body_file: join(linkedRoot, 'linked-draft.md'),
      },
    );

    expect(result.success).toBe(true);
    expect(provider.getSentMessages()[0]!.body).toBe('Body behind a symlinked root');

    await rm(linkedRoot, { force: true });
    await rm(realRoot, { recursive: true, force: true });
  });

  it('Scenario: Relative path does not search allowlisted roots', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'allowed-root-'));
    await writeFile(join(extraDir, 'roaming-draft.md'), 'Body that must not be found');

    const result = await sendEmailAction.run(
      { ...ctx, allowedDirs: [extraDir] },
      {
        to: 'alice@allowed.com',
        subject: 'Test',
        body_file: 'roaming-draft.md',
      },
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('FILE_NOT_FOUND');
    expect(provider.getSentMessages()).toHaveLength(0);

    await rm(extraDir, { recursive: true, force: true });
  });

  it('Scenario: Unset configuration preserves the single-root sandbox', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'unconfigured-root-'));
    await writeFile(join(extraDir, 'outside-draft.md'), 'Body from an unconfigured root');

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Test',
      body_file: join(extraDir, 'outside-draft.md'),
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('PATH_TRAVERSAL');
    expect(result.error!.message).toContain('body_file must be within the working directory');
    expect(provider.getSentMessages()).toHaveLength(0);

    await rm(extraDir, { recursive: true, force: true });
  });

  it('Scenario: Frontmatter format override', async () => {
    await writeFile(join(testDir, 'plain.md'), `---
to: alice@allowed.com
subject: Plain from fm
format: text
---
### Not rendered`);

    const result = await sendEmailAction.run(ctx, {
      body_file: 'plain.md',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    // Frontmatter format: text → send as plain, no rendering
    expect(sent.body).toBe('### Not rendered');
    expect(sent.bodyHtml).toBeUndefined();
  });
});

describe('email-write/Frontmatter Support', () => {
  it('Scenario: Frontmatter values used for to/subject/body', async () => {
    await writeFile(join(testDir, 'fm-draft.md'), `---
to: alice@allowed.com
subject: From Frontmatter
---
Body from frontmatter file.`);

    const result = await sendEmailAction.run(ctx, {
      body_file: 'fm-draft.md',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent[0]!.to[0]!.email).toBe('alice@allowed.com');
    expect(sent[0]!.subject).toBe('From Frontmatter');
    expect(sent[0]!.body).toBe('Body from frontmatter file.');
  });

  it('Scenario: Frontmatter is authoritative — overrides action params', async () => {
    await writeFile(join(testDir, 'override.md'), `---
to: frontmatter@allowed.com
subject: Frontmatter Subject
---
Body.`);

    const result = await sendEmailAction.run(ctx, {
      to: 'param@allowed.com',
      subject: 'Param Subject',
      body_file: 'override.md',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent[0]!.to[0]!.email).toBe('frontmatter@allowed.com');
    expect(sent[0]!.subject).toBe('Frontmatter Subject');
  });

  it('Scenario: Action params fill gaps when frontmatter is partial', async () => {
    await writeFile(join(testDir, 'partial.md'), `---
subject: From Frontmatter Only
---
Body.`);

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      body_file: 'partial.md',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent[0]!.to[0]!.email).toBe('alice@allowed.com');
    expect(sent[0]!.subject).toBe('From Frontmatter Only');
  });

  it('Scenario: Missing to/subject after merge returns MISSING_FIELD', async () => {
    await writeFile(join(testDir, 'nofields.md'), `---
draft: true
---
Body only.`);

    const result = await sendEmailAction.run(ctx, {
      body_file: 'nofields.md',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('MISSING_FIELD');
  });

  it('Scenario: draft: true in frontmatter creates draft', async () => {
    await writeFile(join(testDir, 'draft-mode.md'), `---
to: alice@allowed.com
subject: Draft Mode
draft: true
---
Body.`);

    const result = await sendEmailAction.run(ctx, {
      body_file: 'draft-mode.md',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(provider.getSentMessages()).toHaveLength(0);
  });
});

describe('email-write/Reply Threading Guardrail', () => {
  it('Scenario: Re: subject without reply_to returns REPLY_THREADING_HINT', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Re: Orphaned Reply',
      body: 'Body',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('REPLY_THREADING_HINT');
    expect(result.error!.recoverable).toBe(true);
  });
});

describe('email-write/Draft Workflow', () => {
  it('Scenario: Create and send draft', async () => {
    // Create draft
    const draftResult = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Draft Test',
      body: 'Draft body',
      draft: true,
    });

    expect(draftResult.success).toBe(true);
    expect(draftResult.draftId).toBeDefined();

    // Send the draft
    const sendResult = await provider.sendDraft(draftResult.draftId!);
    expect(sendResult.success).toBe(true);
  });

  it('Scenario: send_email with draft: true to blocked recipient succeeds (drafts bypass allowlist)', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'hacker@evil.com',
      subject: 'Draft to blocked',
      body: 'Body',
      draft: true,
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(provider.getSentMessages()).toHaveLength(0);
    expect(provider.getDrafts().size).toBe(1);
  });
});

describe('email-write/Delivery Failure Handling', () => {
  it('Scenario: Transient delivery failure is not retried', async () => {
    // Send is a non-idempotent operation: a "transient" failure may have
    // occurred after the provider accepted the message, so retrying could
    // deliver duplicates. Exactly one provider attempt is allowed.
    let callCount = 0;
    provider.sendMessage = async () => {
      callCount++;
      throw new ProviderError('SERVICE_UNAVAILABLE', 'Service temporarily unavailable', 'test', true);
    };

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Retry Test',
      body: 'Must not retry',
    });

    expect(callCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.error!.recoverable).toBe(true);
  });

  it('Scenario: Deterministic delivery failure fails fast', async () => {
    let callCount = 0;
    provider.sendMessage = async () => {
      callCount++;
      throw new ProviderError('INVALID_REQUEST', 'ErrorInvalidRecipients', 'microsoft', false);
    };

    const start = Date.now();
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Fail Fast Test',
      body: 'Deterministic failure',
    });

    expect(callCount).toBe(1);
    expect(Date.now() - start).toBeLessThan(500); // no backoff stall
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_REQUEST');
    expect(result.error!.message).toContain('ErrorInvalidRecipients');
    expect(result.error!.recoverable).toBe(false);
  });

  it('Scenario: Plain thrown Error is not retried', async () => {
    let callCount = 0;
    provider.sendMessage = async () => {
      callCount++;
      throw new Error('socket hang up');
    };

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Ambiguous Failure',
      body: 'Body',
    });

    expect(callCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('SEND_STATUS_UNKNOWN');
  });

  it('charges quota and preserves retryAfter when a send outcome is unknown', async () => {
    const recordUsage = vi.fn();
    ctx.rateLimiter = { checkLimit: () => ({ allowed: true }), recordUsage };
    provider.sendMessage = async () => {
      throw new ProviderError('SEND_STATUS_UNKNOWN', 'response lost', 'test', false, 30);
    };

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Unknown outcome',
      body: 'Body',
    });

    expect(result.error).toMatchObject({ code: 'SEND_STATUS_UNKNOWN', retryAfter: 30 });
    expect(recordUsage).toHaveBeenCalledWith('send_email');
  });

  it('Scenario: Permanent failure notification', async () => {
    provider.sendMessage = async () => {
      throw new ProviderError('INVALID_RECIPIENT', 'Mailbox not found', 'test', false);
    };

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Fail Test',
      body: 'Will fail',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_RECIPIENT');
    expect(result.error!.recoverable).toBe(false);
  });
});

describe('email-write/Graceful Body Truncation', () => {
  it('Scenario: Body exceeds size limit', async () => {
    // Create a body larger than 3.5MB
    const largeBody = 'x'.repeat(4 * 1024 * 1024);

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Large Email',
      body: largeBody,
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent).toHaveLength(1);
    // Both plain body and rendered HTML are truncated with the notice
    expect(sent[0]!.body).toContain('This response was truncated because it exceeded email size limits.');
    expect(Buffer.byteLength(sent[0]!.body, 'utf-8')).toBeLessThanOrEqual(3.5 * 1024 * 1024 + 200);
    expect(sent[0]!.bodyHtml).toContain('This response was truncated because it exceeded email size limits.');
    expect(Buffer.byteLength(sent[0]!.bodyHtml!, 'utf-8')).toBeLessThanOrEqual(3.5 * 1024 * 1024 + 200);
  });
});

describe('email-write/Body Rendering', () => {
  it('Scenario: Markdown rendering by default', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Morning Brief',
      body: '### Header\n\n**bold** text',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    // Recipient sees rendered HTML, not literal markdown
    expect(sent.bodyHtml).toContain('<h3>Header</h3>');
    expect(sent.bodyHtml).toContain('<strong>bold</strong>');
    // Raw markdown preserved in plain-text body fallback
    expect(sent.body).toContain('### Header');
  });

  it('Scenario: Single newlines preserved as line breaks', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Line Breaks',
      body: 'line one\nline two\nline three',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.bodyHtml).toMatch(/line one<br\s*\/?>\s*line two/);
    expect(sent.bodyHtml).toMatch(/line two<br\s*\/?>\s*line three/);
  });

  it('Scenario: GFM tables render', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Table',
      body: '| a | b |\n| - | - |\n| 1 | 2 |',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.bodyHtml).toContain('<table>');
    expect(sent.bodyHtml).toContain('<th>a</th>');
    expect(sent.bodyHtml).toContain('<td>1</td>');
  });

  it('Scenario: format text bypasses rendering', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Literal',
      body: '### Literal',
      format: 'text',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.body).toBe('### Literal');
    expect(sent.bodyHtml).toBeUndefined();
  });

  it('Scenario: format html passthrough', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Pre-rendered',
      body: '<h1>Pre-rendered</h1>',
      format: 'html',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.bodyHtml).toContain('<h1>Pre-rendered</h1>');
  });

  it('Scenario: Raw HTML embedded in markdown is preserved', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Inline HTML',
      body: 'Hi <a href="https://example.com">link</a>',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.bodyHtml).toContain('<a href="https://example.com">link</a>');
  });

  it('Scenario: force_black wrapper default', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Default wrapper',
      body: 'plain paragraph',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.bodyHtml).toContain('<div style="color: #000000;">');
  });

  it('Scenario: force_black opt-out', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'No wrapper',
      body: 'plain text',
      force_black: false,
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.bodyHtml).not.toContain('<div style="color: #000000;">');
  });

  it('Scenario: Frontmatter format is authoritative', async () => {
    await writeFile(join(testDir, 'override.md'), `---
to: alice@allowed.com
subject: FM wins
format: text
---
### Not rendered`);

    const result = await sendEmailAction.run(ctx, {
      body_file: 'override.md',
      format: 'markdown', // action param says markdown, frontmatter says text
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    // Frontmatter wins
    expect(sent.body).toBe('### Not rendered');
    expect(sent.bodyHtml).toBeUndefined();
  });
});

describe('email-write/Send Address Parsing', () => {
  it('Scenario: name-address strings parse on send path (to + cc)', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: ['Alice <alice@allowed.com>'],
      cc: ['"Doe, Bob" <bob@allowed.com>'],
      subject: 'Hi',
      body: 'Hello team',
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages()[0]!;
    expect(sent.to).toEqual([{ name: 'Alice', email: 'alice@allowed.com' }]);
    expect(sent.cc).toEqual([{ name: 'Doe, Bob', email: 'bob@allowed.com' }]);
  });

  it('Scenario: name-address strings parse on draft path', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'Alice <alice@allowed.com>',
      cc: ['Bob <bob@allowed.com>'],
      subject: 'Draft hi',
      body: 'Hello team',
      draft: true,
    });

    expect(result.success).toBe(true);
    const draft = [...provider.getDrafts().values()][0]!;
    expect(draft.to).toEqual([{ name: 'Alice', email: 'alice@allowed.com' }]);
    expect(draft.cc).toEqual([{ name: 'Bob', email: 'bob@allowed.com' }]);
  });

  it('Scenario: name-address `to` is NOT falsely rejected by allowlist (regression guard)', async () => {
    // Pre-fix, allowlist saw 'Alice <alice@allowed.com>' verbatim and rejected it.
    // Post-fix, allowlist receives the parsed bare email and accepts.
    const result = await sendEmailAction.run(ctx, {
      to: 'Alice <alice@allowed.com>',
      subject: 'Hi',
      body: 'Hello',
    });

    expect(result.success).toBe(true);
  });

  it('Scenario: invalid `to` returns INVALID_ADDRESS with field/index', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: ['alice@allowed.com', 'not an email'],
      subject: 'Bad',
      body: 'Hi',
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_ADDRESS');
    expect(result.error!.message).toContain('to[1]');
    expect(result.error!.message).toContain('not an email');
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: invalid `cc` returns INVALID_ADDRESS even on draft path', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      cc: ['bob@allowed.com', 'Alice <a@x>, Bob <b@y>'],
      subject: 'Bad',
      body: 'Hi',
      draft: true,
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_ADDRESS');
    expect(result.error!.message).toContain('cc[1]');
    expect(provider.getDrafts().size).toBe(0);
  });
});

describe('email-write/Duplicate Delivery Guard', () => {
  const MESSAGE = {
    to: 'alice@allowed.com',
    subject: 'Quarterly update',
    body: 'Numbers attached.',
  };

  it('Scenario: Replay after successful delivery is blocked', async () => {
    const first = await sendEmailAction.run(ctx, MESSAGE);
    expect(first.success).toBe(true);

    const replay = await sendEmailAction.run(ctx, MESSAGE);

    expect(replay.success).toBe(false);
    expect(replay.error!.code).toBe('DUPLICATE_SEND_BLOCKED');
    expect(replay.error!.recoverable).toBe(false);
    // The caller asked whether this went out; the honest answer names which
    // message it already is.
    expect(replay.messageId).toBe(first.messageId);
    // The provider was touched exactly once, which is the whole point.
    expect(provider.getSentMessages()).toHaveLength(1);
  });

  it('Scenario: Replay after ambiguous outcome is blocked', async () => {
    let calls = 0;
    provider.sendMessage = async () => {
      calls++;
      throw new ProviderError('SEND_STATUS_UNKNOWN', 'response lost', 'test', false);
    };

    const first = await sendEmailAction.run(ctx, MESSAGE);
    expect(first.error!.code).toBe('SEND_STATUS_UNKNOWN');

    const replay = await sendEmailAction.run(ctx, MESSAGE);

    expect(calls).toBe(1);
    expect(replay.error!.code).toBe('DUPLICATE_SEND_UNRESOLVED');
    expect(replay.error!.message).toContain('Sent Items');
  });

  it('Scenario: Concurrent identical send is blocked while in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    provider.sendMessage = async () => {
      calls++;
      await gate;
      return { success: true, messageId: 'concurrent-1' };
    };

    const inFlight = sendEmailAction.run(ctx, MESSAGE);
    // Second call arrives before the first has returned — the lost-ack replay
    // in its most literal form.
    const second = await sendEmailAction.run(ctx, MESSAGE);
    release();
    const first = await inFlight;

    expect(first.success).toBe(true);
    expect(second.error!.code).toBe('DUPLICATE_SEND_IN_FLIGHT');
    expect(calls).toBe(1);
  });

  it('Scenario: Resend after a proven rejection is allowed', async () => {
    let calls = 0;
    provider.sendMessage = async () => {
      calls++;
      if (calls === 1) {
        // 4xx-derived: the provider received AND rejected it, so nothing was
        // delivered and a resend must not be blocked.
        throw new ProviderError('INVALID_REQUEST', 'ErrorInvalidRecipients', 'microsoft', false);
      }
      return { success: true, messageId: 'retry-ok' };
    };

    const rejected = await sendEmailAction.run(ctx, MESSAGE);
    expect(rejected.error!.code).toBe('INVALID_REQUEST');

    const resend = await sendEmailAction.run(ctx, MESSAGE);
    expect(resend.success).toBe(true);
    expect(resend.messageId).toBe('retry-ok');
    expect(calls).toBe(2);
  });

  it('Scenario: Unrecognized failure code is held as unresolved', async () => {
    let calls = 0;
    provider.sendMessage = async () => {
      calls++;
      throw new ProviderError('SOME_FUTURE_PROVIDER_CODE', 'who knows', 'test', false);
    };

    await sendEmailAction.run(ctx, MESSAGE);
    const replay = await sendEmailAction.run(ctx, MESSAGE);

    expect(calls).toBe(1);
    expect(replay.error!.code).toBe('DUPLICATE_SEND_UNRESOLVED');
  });

  it('Scenario: A different message is not blocked', async () => {
    // Negative control: a guard that blocks everything is not a guard. If this
    // test ever passes for the wrong reason, the ones above prove nothing.
    await sendEmailAction.run(ctx, MESSAGE);

    const otherBody = await sendEmailAction.run(ctx, { ...MESSAGE, body: 'Numbers attached!' });
    const otherRecipient = await sendEmailAction.run(ctx, { ...MESSAGE, to: 'bob@allowed.com' });
    const otherSubject = await sendEmailAction.run(ctx, { ...MESSAGE, subject: 'Quarterly update v2' });

    expect(otherBody.success).toBe(true);
    expect(otherRecipient.success).toBe(true);
    expect(otherSubject.success).toBe(true);
    expect(provider.getSentMessages()).toHaveLength(4);
  });

  it('Scenario: Explicit duplicate override delivers', async () => {
    await sendEmailAction.run(ctx, MESSAGE);
    const forced = await sendEmailAction.run(ctx, { ...MESSAGE, allow_duplicate: true });

    expect(forced.success).toBe(true);
    expect(provider.getSentMessages()).toHaveLength(2);

    // The deliberate duplicate re-arms the guard against its own replay.
    const replay = await sendEmailAction.run(ctx, MESSAGE);
    expect(replay.error!.code).toBe('DUPLICATE_SEND_BLOCKED');
    expect(provider.getSentMessages()).toHaveLength(2);
  });

  it('Scenario: Guard disabled by window of zero', async () => {
    ctx.sendLedger = new SendLedger({ windowMs: 0 });

    await sendEmailAction.run(ctx, MESSAGE);
    const replay = await sendEmailAction.run(ctx, MESSAGE);

    expect(replay.success).toBe(true);
    expect(provider.getSentMessages()).toHaveLength(2);
  });

  it('Scenario: Guard is active without embedder wiring', async () => {
    // The production path: the MCP adapter builds an ActionContext with no
    // sendLedger, so the actions must fall back to the process default rather
    // than skipping the check. ActionContext.rateLimiter is the cautionary
    // example — an optional interface no shipped adapter constructs, so the
    // limit it describes does not exist in the product.
    resetDefaultSendLedger();
    try {
      const unwired: ActionContext = {
        provider,
        sendAllowlist: { entries: ['*@allowed.com'] },
        safeDir: testDir,
      };

      const first = await sendEmailAction.run(unwired, MESSAGE);
      const replay = await sendEmailAction.run(unwired, MESSAGE);

      expect(first.success).toBe(true);
      expect(replay.error!.code).toBe('DUPLICATE_SEND_BLOCKED');
      expect(provider.getSentMessages()).toHaveLength(1);
    } finally {
      resetDefaultSendLedger();
    }
  });

  it('Scenario: A bail-out before dispatch does not block the corrected call', async () => {
    // An allowlist refusal never touched the provider, so it must not leave a
    // record that blocks the corrected send.
    const blocked = await sendEmailAction.run(ctx, { ...MESSAGE, to: 'stranger@elsewhere.com' });
    expect(blocked.error!.code).toBe('ALLOWLIST_BLOCKED');

    const allowed = await sendEmailAction.run(ctx, MESSAGE);
    expect(allowed.success).toBe(true);
  });

  it('does not guard the draft path — creating a draft delivers nothing', async () => {
    const first = await sendEmailAction.run(ctx, { ...MESSAGE, draft: true });
    const second = await sendEmailAction.run(ctx, { ...MESSAGE, draft: true });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(provider.getDrafts().size).toBe(2);
  });

  it('guards a scheduled send, and separately from the same message sent now', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();

    const scheduled = await sendEmailAction.run(ctx, { ...MESSAGE, scheduled_send_at: at });
    expect(scheduled.success).toBe(true);

    const replay = await sendEmailAction.run(ctx, { ...MESSAGE, scheduled_send_at: at });
    expect(replay.error!.code).toBe('DUPLICATE_SEND_BLOCKED');

    // Same bytes, different delivery time — a different decision, not a replay.
    const immediate = await sendEmailAction.run(ctx, MESSAGE);
    expect(immediate.success).toBe(true);
  });
});
