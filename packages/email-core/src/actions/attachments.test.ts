import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { listAttachmentsAction, detectMimeType, validateAttachment, sanitizeFilename } from './attachments.js';
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
      mimeType: 'application/pdf',
      size: 245000,
      isInline: false,
    });
    expect(result.attachments[1]).toMatchObject({
      id: 'att2',
      isInline: true,
    });
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
  it('Scenario: MIME type detected from bytes', () => {
    // JPEG magic bytes (FF D8 FF)
    const jpegContent = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const detected = detectMimeType(jpegContent, 'text/plain');

    // Should detect as image/jpeg despite declared text/plain
    expect(detected).toBe('image/jpeg');
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
