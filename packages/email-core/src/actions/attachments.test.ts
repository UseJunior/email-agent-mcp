import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { listAttachmentsAction, downloadAttachmentAction, detectMimeType, validateAttachment, sanitizeFilename, ZIP_CONTAINER_TYPES } from './attachments.js';
import { AttachmentNotSupportedError, AttachmentNotFoundError } from '../providers/provider.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  ctx = { provider };
});

describe('email-attachments/Download Attachments', () => {
  it('Scenario: List attachments', async () => {
    provider.addMessage({
      id: 'msg1',
      subject: 'With attachments',
      isRead: true,
      hasAttachments: true,
      attachments: [
        { id: 'att1', filename: 'report.pdf', mimeType: 'application/pdf', size: 245000, isInline: false },
        { id: 'att2', filename: 'logo.png', mimeType: 'image/png', size: 50000, contentId: 'image001', isInline: true },
      ],
    });

    const result = await listAttachmentsAction.run(ctx, { message_id: 'msg1' });

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]).toMatchObject({
      id: 'att1',
      filename: 'report.pdf',
      original_filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 245000,
      isInline: false,
    });
    expect(result.attachments[1]).toMatchObject({
      id: 'att2',
      isInline: true,
    });
  });

  it('Scenario: list_attachments preserves the raw filename in original_filename even when sanitization mangles it', async () => {
    provider.addMessage({
      id: 'msg-i18n',
      hasAttachments: true,
      attachments: [
        { id: 'att-i18n', filename: 'Räsumé (Final).pdf', mimeType: 'application/pdf', size: 1024, isInline: false },
      ],
    });

    const result = await listAttachmentsAction.run(ctx, { message_id: 'msg-i18n' });

    expect(result.attachments[0]!.original_filename).toBe('Räsumé (Final).pdf');
    expect(result.attachments[0]!.filename).toMatch(/\.pdf$/);
    expect(result.attachments[0]!.filename).not.toContain('(');
  });
});

describe('email-attachments/Download Attachment', () => {
  const PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf body for tests');

  it('Scenario: Happy path returns sanitized filename, original_filename, declared mimeType, and round-trippable base64', async () => {
    provider.addMessage({
      id: 'msg-dl',
      hasAttachments: true,
      attachments: [
        { id: 'att-1', filename: 'Report (Final).pdf', mimeType: 'application/pdf', size: PDF_BYTES.length, isInline: false },
      ],
    });
    provider.addAttachmentData('msg-dl', 'att-1', PDF_BYTES);

    const result = await downloadAttachmentAction.run(ctx, {
      message_id: 'msg-dl',
      attachment_id: 'att-1',
      max_size_mb: 5,
    });

    expect(result.success).toBe(true);
    expect(result.mimeType).toBe('application/pdf');
    expect(result.size).toBe(PDF_BYTES.length);
    expect(result.filename).not.toContain('(');
    expect(result.filename).toMatch(/\.pdf$/);
    expect(result.original_filename).toBe('Report (Final).pdf');
    expect(Buffer.from(result.base64!, 'base64').equals(PDF_BYTES)).toBe(true);
  });

  it('Scenario: Non-ASCII filename round-trips through original_filename while filename gets sanitized', async () => {
    provider.addMessage({
      id: 'msg-i18n',
      hasAttachments: true,
      attachments: [
        { id: 'att-i18n', filename: 'Räsumé.pdf', mimeType: 'application/pdf', size: PDF_BYTES.length, isInline: false },
      ],
    });
    provider.addAttachmentData('msg-i18n', 'att-i18n', PDF_BYTES);

    const result = await downloadAttachmentAction.run(ctx, {
      message_id: 'msg-i18n',
      attachment_id: 'att-i18n',
      max_size_mb: 5,
    });

    expect(result.success).toBe(true);
    expect(result.original_filename).toBe('Räsumé.pdf');
    expect(result.filename).toMatch(/\.pdf$/);
  });

  it('Scenario: Size rejection when downloaded payload exceeds the cap', async () => {
    const actualBuf = Buffer.alloc(2 * 1024 * 1024);
    provider.addMessage({
      id: 'msg-big',
      hasAttachments: true,
      attachments: [
        { id: 'att-big', filename: 'huge.bin', mimeType: 'application/octet-stream', size: actualBuf.length, isInline: false },
      ],
    });
    provider.addAttachmentData('msg-big', 'att-big', actualBuf);

    const result = await downloadAttachmentAction.run(ctx, {
      message_id: 'msg-big',
      attachment_id: 'att-big',
      max_size_mb: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(result.error?.message).toMatch(/exceeds max_size_mb=1/);
  });

  it('Scenario: NOT_SUPPORTED when provider lacks downloadAttachment', async () => {
    const stubCtx: ActionContext = { provider: { getMessage: async () => ({ attachments: [] }) } as never };

    const result = await downloadAttachmentAction.run(stubCtx, {
      message_id: 'msg-x',
      attachment_id: 'att-x',
      max_size_mb: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_SUPPORTED');
  });

  it('Scenario: ATTACHMENT_NOT_FOUND when provider throws AttachmentNotFoundError (race deletion or bad id)', async () => {
    provider.addMessage({
      id: 'msg-empty',
      hasAttachments: true,
      attachments: [
        { id: 'att-other', filename: 'other.pdf', mimeType: 'application/pdf', size: 10, isInline: false },
      ],
    });

    const result = await downloadAttachmentAction.run(ctx, {
      message_id: 'msg-empty',
      attachment_id: 'att-missing',
      max_size_mb: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('Scenario: explicit AttachmentNotFoundError thrown by provider maps to ATTACHMENT_NOT_FOUND', async () => {
    vi.spyOn(provider, 'downloadAttachment').mockRejectedValue(
      new AttachmentNotFoundError('race-deleted attachment'),
    );

    const result = await downloadAttachmentAction.run(ctx, {
      message_id: 'msg-deleted',
      attachment_id: 'att-deleted',
      max_size_mb: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ATTACHMENT_NOT_FOUND');
    expect(result.error?.message).toMatch(/race-deleted/);
  });

  it('Scenario: NOT_SUPPORTED when provider throws AttachmentNotSupportedError during download (e.g. Graph itemAttachment)', async () => {
    vi.spyOn(provider, 'downloadAttachment').mockRejectedValue(
      new AttachmentNotSupportedError('Attachment att-item has @odata.type=#microsoft.graph.itemAttachment'),
    );

    const result = await downloadAttachmentAction.run(ctx, {
      message_id: 'msg-item',
      attachment_id: 'att-item',
      max_size_mb: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_SUPPORTED');
    expect(result.error?.message).toMatch(/itemAttachment/);
  });

  it('Scenario: Network errors are NOT swallowed — must propagate so wrapAction returns PROVIDER_UNAVAILABLE', async () => {
    vi.spyOn(provider, 'downloadAttachment').mockRejectedValue(new Error('Network unreachable'));

    await expect(
      downloadAttachmentAction.run(ctx, {
        message_id: 'msg-any',
        attachment_id: 'att-any',
        max_size_mb: 5,
      }),
    ).rejects.toThrow('Network unreachable');
  });

  it('Scenario: Gmail synthetic part:* attachment IDs are passed through unchanged to the provider', async () => {
    const PART_ID = 'part:1.0';
    provider.addMessage({
      id: 'msg-inline',
      hasAttachments: true,
      attachments: [
        { id: PART_ID, filename: 'logo.png', mimeType: 'image/png', size: 4, isInline: true, contentId: 'image001' },
      ],
    });
    provider.addAttachmentData('msg-inline', PART_ID, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const downloadSpy = vi.spyOn(provider, 'downloadAttachment');

    const result = await downloadAttachmentAction.run(ctx, {
      message_id: 'msg-inline',
      attachment_id: PART_ID,
      max_size_mb: 5,
    });

    expect(result.success).toBe(true);
    expect(downloadSpy).toHaveBeenCalledWith('msg-inline', PART_ID);
  });
});

describe('email-attachments/Inline Image Handling', () => {
  it('Scenario: Embedded image in HTML body', async () => {
    provider.addMessage({
      id: 'msg-inline',
      subject: 'With inline image',
      isRead: true,
      hasAttachments: true,
      bodyHtml: '<p>See image: <img src="cid:image001"></p>',
      attachments: [
        { id: 'att-inline', filename: 'logo.png', mimeType: 'image/png', size: 50000, contentId: 'image001', isInline: true },
        { id: 'att-regular', filename: 'report.pdf', mimeType: 'application/pdf', size: 245000, isInline: false },
      ],
    });

    const result = await listAttachmentsAction.run(ctx, { message_id: 'msg-inline' });

    // Separates embedded images from regular attachments
    const inlineAtts = result.attachments.filter(a => a.isInline);
    const regularAtts = result.attachments.filter(a => !a.isInline);
    expect(inlineAtts).toHaveLength(1);
    expect(inlineAtts[0]!.contentId).toBe('image001');
    expect(regularAtts).toHaveLength(1);
  });
});

describe('email-attachments/Attach Files to Outbound', () => {
  it('Scenario: Attach file to reply', async () => {
    provider.addMessage({
      id: 'original',
      subject: 'Request',
      from: { email: 'alice@corp.com' },
      isRead: true,
      hasAttachments: false,
    });

    // Reply with an attachment
    const result = await provider.replyToMessage('original', 'Here is the report', {
      attachments: [{
        filename: 'report.pdf',
        content: Buffer.from('PDF content'),
        mimeType: 'application/pdf',
      }],
    });

    expect(result.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(sent[0]!.attachments![0]!.filename).toBe('report.pdf');
  });
});

describe('email-attachments/Size and Type Validation', () => {
  it('Scenario: Oversized attachment rejected', () => {
    const oversized = Buffer.alloc(26 * 1024 * 1024); // 26MB
    const result = validateAttachment(oversized, 'big-file.pdf');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Attachment exceeds maximum size of 25MB');
  });
});

describe('email-attachments/Binary File Detection', () => {
  // ZIP local file header (PK\x03\x04) — shared by plain archives and all
  // OOXML/ODF documents.
  const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);

  it('Scenario: MIME type detected from bytes', () => {
    // JPEG magic bytes (FF D8 FF)
    const jpegContent = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const detected = detectMimeType(jpegContent, 'text/plain');

    // Should detect as image/jpeg despite declared text/plain
    expect(detected).toBe('image/jpeg');
  });

  it('Scenario: OOXML/ODF extensions disambiguate the generic ZIP magic (#98)', () => {
    // Spot-check the flagship types map to the exact expected strings...
    expect(detectMimeType(ZIP_BYTES, undefined, 'report.docx'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(detectMimeType(ZIP_BYTES, undefined, 'sheet.xlsx'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(detectMimeType(ZIP_BYTES, undefined, 'deck.pptx'))
      .toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');

    // ...then cover EVERY mapped extension so the map and test cannot drift.
    for (const [ext, expected] of Object.entries(ZIP_CONTAINER_TYPES)) {
      expect(detectMimeType(ZIP_BYTES, undefined, `file${ext}`)).toBe(expected);
      expect(expected).not.toBe('application/zip');
    }
  });

  it('Scenario: extension match is case-insensitive', () => {
    expect(detectMimeType(ZIP_BYTES, undefined, 'REPORT.DOCX'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('Scenario: a plain .zip archive still detects as application/zip', () => {
    expect(detectMimeType(ZIP_BYTES, undefined, 'archive.zip')).toBe('application/zip');
    expect(detectMimeType(ZIP_BYTES, undefined, 'no-extension')).toBe('application/zip');
    expect(detectMimeType(ZIP_BYTES)).toBe('application/zip');
  });

  it('Scenario: declared type wins over the generic ZIP magic', () => {
    expect(detectMimeType(ZIP_BYTES, 'application/epub+zip', 'book.epub')).toBe('application/epub+zip');
    // Declared beats the extension map too — an explicit override is authoritative.
    expect(detectMimeType(ZIP_BYTES, 'application/zip', 'report.docx')).toBe('application/zip');
  });

  it('Scenario: specific magic matches still win over declared type', () => {
    const pdfContent = Buffer.from('%PDF-1.4 body');
    expect(detectMimeType(pdfContent, 'application/octet-stream', 'file.docx')).toBe('application/pdf');
  });

  it('Scenario: validateAttachment threads the filename into detection (#98)', () => {
    const result = validateAttachment(ZIP_BYTES, 'contract.docx');
    expect(result.valid).toBe(true);
    expect(result.detectedMimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});

describe('email-attachments/Filename Sanitization', () => {
  it('Scenario: Special characters in filename', () => {
    const result = sanitizeFilename('Term Sheet - Alexander Morgan (Draft).pdf');

    expect(result).toMatch(/\.pdf$/);
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
    // Should be a reasonable filename
    expect(result.length).toBeGreaterThan(4);
  });
});
