import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { sendEmailAction } from './send.js';
import { ProviderError } from '../providers/provider.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;
let testDir: string;

beforeEach(async () => {
  provider = new MockEmailProvider();
  testDir = join(tmpdir(), `agent-email-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  ctx = {
    provider,
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
});

describe('email-write/Delivery Failure Handling', () => {
  it('Scenario: Transient error retry', async () => {
    let callCount = 0;
    const originalSend = provider.sendMessage.bind(provider);
    provider.sendMessage = async (msg) => {
      callCount++;
      if (callCount <= 2) {
        throw new ProviderError('SERVICE_UNAVAILABLE', 'Service temporarily unavailable', 'test', true);
      }
      return originalSend(msg);
    };

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Retry Test',
      body: 'Will retry',
    });

    expect(result.success).toBe(true);
    expect(callCount).toBe(3); // 2 failures + 1 success
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
    expect(sent[0]!.body).toContain('This response was truncated because it exceeded email size limits.');
    expect(Buffer.byteLength(sent[0]!.body, 'utf-8')).toBeLessThanOrEqual(3.5 * 1024 * 1024 + 200);
  });
});
