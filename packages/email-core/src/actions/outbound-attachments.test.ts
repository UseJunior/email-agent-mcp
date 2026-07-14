// Outbound attachment coverage for create_draft / update_draft / send_email /
// reply_to_email — issue #89.
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { sendEmailAction } from './send.js';
import { createDraftAction, updateDraftAction } from './draft.js';
import { replyToEmailAction } from './reply.js';
import type { ActionContext } from './registry.js';

// Minimal valid PDF — the %PDF magic bytes drive MIME detection.
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n', 'utf-8');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

const VALID_MSG_ID = 'abc123def456ghi789jkl012';

let provider: MockEmailProvider;
let ctx: ActionContext;
let testDir: string;

beforeEach(async () => {
  provider = new MockEmailProvider();
  provider.addMessage({
    id: VALID_MSG_ID,
    subject: 'Original',
    from: { email: 'partner@allowed.com', name: 'Partner' },
    to: [{ email: 'me@company.com' }],
    receivedAt: '2026-05-01T10:00:00Z',
    isRead: true,
    hasAttachments: false,
  });
  testDir = join(tmpdir(), `outbound-att-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  ctx = {
    provider,
    mailboxName: 'work',
    allMailboxes: [
      { name: 'work', emailAddress: 'me@company.com', provider, providerType: 'microsoft', isDefault: true, status: 'connected' },
    ],
    sendAllowlist: { entries: ['*@allowed.com'] },
    safeDir: testDir,
  };
});

describe('outbound-attachments/send_email', () => {
  it('Scenario: single file by path', async () => {
    await writeFile(join(testDir, 'doc.pdf'), PDF_BYTES);

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'With attachment',
      body: 'See attached.',
      attachments: [{ path: 'doc.pdf' }],
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(sent[0]!.attachments![0]!.filename).toBe('doc.pdf');
    expect(sent[0]!.attachments![0]!.content.equals(PDF_BYTES)).toBe(true);
    expect(sent[0]!.attachments![0]!.mimeType).toBe('application/pdf');
  });

  it('Scenario: multiple files by path preserve order', async () => {
    await writeFile(join(testDir, 'a.pdf'), PDF_BYTES);
    await writeFile(join(testDir, 'b.png'), PNG_BYTES);

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Two files',
      body: 'body',
      attachments: [{ path: 'a.pdf' }, { path: 'b.png' }],
    });

    expect(result.success).toBe(true);
    const att = provider.getSentMessages()[0]!.attachments!;
    expect(att.map(a => a.filename)).toEqual(['a.pdf', 'b.png']);
  });

  it('Scenario: base64 input with explicit filename', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Inline base64',
      body: 'body',
      attachments: [{ base64: PDF_BYTES.toString('base64'), filename: 'inline.pdf' }],
    });

    expect(result.success).toBe(true);
    const att = provider.getSentMessages()[0]!.attachments![0]!;
    expect(att.filename).toBe('inline.pdf');
    expect(att.content.equals(PDF_BYTES)).toBe(true);
  });

  it('Scenario: .docx attachment gets the Word MIME type, not application/zip (#98)', async () => {
    // OOXML files are ZIP containers — start with the PK magic.
    const docxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
    await writeFile(join(testDir, 'term-sheet.docx'), docxBytes);

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Word doc',
      body: 'body',
      attachments: [{ path: 'term-sheet.docx' }],
    });

    expect(result.success).toBe(true);
    expect(provider.getSentMessages()[0]!.attachments![0]!.mimeType)
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('Scenario: MIME inference overrides a wrong declared type', async () => {
    await writeFile(join(testDir, 'mystery.pdf'), PDF_BYTES);

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Mime',
      body: 'body',
      attachments: [{ path: 'mystery.pdf', mimeType: 'application/octet-stream' }],
    });

    expect(result.success).toBe(true);
    expect(provider.getSentMessages()[0]!.attachments![0]!.mimeType).toBe('application/pdf');
  });

  it('Scenario: missing file returns a structured error', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Missing',
      body: 'body',
      attachments: [{ path: 'nope.pdf' }],
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('FILE_NOT_FOUND');
    expect(result.error!.message).toContain('attachments[0]');
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: path traversal is rejected', async () => {
    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Traversal',
      body: 'body',
      attachments: [{ path: '../../../etc/passwd' }],
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('PATH_TRAVERSAL');
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: oversize file (>25MB) is rejected', async () => {
    await writeFile(join(testDir, 'huge.bin'), Buffer.alloc(25 * 1024 * 1024 + 1));

    const result = await sendEmailAction.run(ctx, {
      to: 'alice@allowed.com',
      subject: 'Huge',
      body: 'body',
      attachments: [{ path: 'huge.bin' }],
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(provider.getSentMessages()).toHaveLength(0);
  });

  it('Scenario: malformed base64 is rejected by the input schema', () => {
    const parsed = sendEmailAction.input.safeParse({
      to: 'alice@allowed.com',
      subject: 'Bad',
      body: 'body',
      attachments: [{ base64: 'not valid base64 !!!', filename: 'x.bin' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('Scenario: base64 with a valid charset but invalid length is rejected', () => {
    // "abcde" — all base64 chars but not a valid quartet length; Node's
    // decoder would silently truncate it instead of erroring.
    const parsed = sendEmailAction.input.safeParse({
      to: 'alice@allowed.com',
      subject: 'Bad',
      body: 'body',
      attachments: [{ base64: 'abcde', filename: 'x.bin' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('Scenario: an attachment with neither path nor base64 is rejected', () => {
    const parsed = sendEmailAction.input.safeParse({
      to: 'alice@allowed.com',
      subject: 'Bad',
      body: 'body',
      attachments: [{ filename: 'x.bin' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('Scenario: base64 attachment without filename is rejected', () => {
    const parsed = sendEmailAction.input.safeParse({
      to: 'alice@allowed.com',
      subject: 'Bad',
      body: 'body',
      attachments: [{ base64: PDF_BYTES.toString('base64') }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('outbound-attachments/create_draft', () => {
  it('Scenario: create_draft carries attachments to the provider', async () => {
    await writeFile(join(testDir, 'doc.pdf'), PDF_BYTES);

    const result = await createDraftAction.run(ctx, {
      to: 'anyone@example.com',
      subject: 'Draft with file',
      body: 'body',
      attachments: [{ path: 'doc.pdf' }],
    });

    expect(result.success).toBe(true);
    const draft = provider.getDrafts().get(result.draftId!);
    expect(draft!.attachments).toHaveLength(1);
    expect(draft!.attachments![0]!.filename).toBe('doc.pdf');
  });
});

describe('outbound-attachments/update_draft', () => {
  it('Scenario: omitting attachments preserves the existing set', async () => {
    await writeFile(join(testDir, 'doc.pdf'), PDF_BYTES);
    const created = await createDraftAction.run(ctx, {
      to: 'anyone@example.com',
      subject: 'Original subject',
      body: 'body',
      attachments: [{ path: 'doc.pdf' }],
    });
    const draftId = created.draftId!;

    const updated = await updateDraftAction.run(ctx, {
      draft_id: draftId,
      subject: 'New subject',
    });

    expect(updated.success).toBe(true);
    const draft = provider.getDrafts().get(draftId)!;
    expect(draft.subject).toBe('New subject');
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments![0]!.filename).toBe('doc.pdf');
  });

  it('Scenario: providing attachments replaces the existing set', async () => {
    await writeFile(join(testDir, 'old.pdf'), PDF_BYTES);
    await writeFile(join(testDir, 'new.png'), PNG_BYTES);
    const created = await createDraftAction.run(ctx, {
      to: 'anyone@example.com',
      subject: 'Subject',
      body: 'body',
      attachments: [{ path: 'old.pdf' }],
    });
    const draftId = created.draftId!;

    const updated = await updateDraftAction.run(ctx, {
      draft_id: draftId,
      attachments: [{ path: 'new.png' }],
    });

    expect(updated.success).toBe(true);
    const draft = provider.getDrafts().get(draftId)!;
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments![0]!.filename).toBe('new.png');
  });

  it('Scenario: an empty attachments array removes all attachments', async () => {
    await writeFile(join(testDir, 'old.pdf'), PDF_BYTES);
    const created = await createDraftAction.run(ctx, {
      to: 'anyone@example.com',
      subject: 'Subject',
      body: 'body',
      attachments: [{ path: 'old.pdf' }],
    });
    const draftId = created.draftId!;

    const updated = await updateDraftAction.run(ctx, {
      draft_id: draftId,
      attachments: [],
    });

    expect(updated.success).toBe(true);
    expect(provider.getDrafts().get(draftId)!.attachments).toEqual([]);
  });
});

describe('outbound-attachments/reply_to_email', () => {
  it('Scenario: reply send path carries attachments', async () => {
    await writeFile(join(testDir, 'doc.pdf'), PDF_BYTES);

    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Reply body',
      reply_all: true,
      attachments: [{ path: 'doc.pdf' }],
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(sent[0]!.attachments![0]!.filename).toBe('doc.pdf');
  });

  it('Scenario: reply draft path carries attachments', async () => {
    await writeFile(join(testDir, 'doc.pdf'), PDF_BYTES);

    const result = await replyToEmailAction.run(ctx, {
      message_id: VALID_MSG_ID,
      body: 'Reply body',
      draft: true,
      reply_all: true,
      attachments: [{ path: 'doc.pdf' }],
    });

    expect(result.success).toBe(true);
    const draft = provider.getDrafts().get(result.draftId!);
    expect(draft!.attachments).toHaveLength(1);
  });
});
