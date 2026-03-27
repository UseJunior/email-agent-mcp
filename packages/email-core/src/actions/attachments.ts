// Attachment handling actions
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { EmailAction } from './registry.js';

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

// Binary file magic bytes
const MAGIC_BYTES: [Buffer, string][] = [
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
  [Buffer.from([0x47, 0x49, 0x46]), 'image/gif'],
  [Buffer.from([0x25, 0x50, 0x44, 0x46]), 'application/pdf'],
  [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip'],
];

/**
 * Detect MIME type from file content magic bytes.
 */
export function detectMimeType(content: Buffer, declaredType?: string): string {
  for (const [magic, mimeType] of MAGIC_BYTES) {
    if (content.length >= magic.length && content.subarray(0, magic.length).equals(magic)) {
      return mimeType;
    }
  }
  return declaredType ?? 'application/octet-stream';
}

/**
 * Sanitize a filename for safe storage.
 * Preserves extension, removes unsafe characters.
 */
export function sanitizeFilename(filename: string): string {
  const ext = extname(filename);
  const base = filename.slice(0, filename.length - ext.length);

  // Replace unsafe characters with underscores, keep dashes and dots
  const sanitized = base
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return (sanitized || 'attachment') + ext;
}

// List attachments for a message
const ListAttachmentsInput = z.object({
  message_id: z.string(),
  mailbox: z.string().optional(),
});

const AttachmentInfo = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  contentId: z.string().optional(),
  isInline: z.boolean(),
});

const ListAttachmentsOutput = z.object({
  attachments: z.array(AttachmentInfo),
});

export const listAttachmentsAction: EmailAction<
  z.infer<typeof ListAttachmentsInput>,
  z.infer<typeof ListAttachmentsOutput>
> = {
  name: 'list_attachments',
  description: 'List attachments for a specific email message',
  input: ListAttachmentsInput,
  output: ListAttachmentsOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const msg = await ctx.provider.getMessage(input.message_id);
    const attachments = (msg.attachments ?? []).map(a => ({
      id: a.id,
      filename: sanitizeFilename(a.filename),
      mimeType: a.mimeType,
      size: a.size,
      contentId: a.contentId,
      isInline: a.isInline,
    }));
    return { attachments };
  },
};

// Validate attachment for outbound
export function validateAttachment(
  content: Buffer,
  filename: string,
  declaredMimeType?: string,
): { valid: boolean; detectedMimeType: string; error?: string } {
  if (content.length > MAX_ATTACHMENT_SIZE) {
    return {
      valid: false,
      detectedMimeType: declaredMimeType ?? 'unknown',
      error: `Attachment exceeds maximum size of 25MB`,
    };
  }

  const detectedMimeType = detectMimeType(content, declaredMimeType);

  return { valid: true, detectedMimeType };
}
