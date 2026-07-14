// Attachment handling actions
import { z } from 'zod';
import { extname } from 'node:path';
import type { EmailAction } from './registry.js';
import { AttachmentNotSupportedError, AttachmentNotFoundError } from '../providers/provider.js';
import { MAX_ATTACHMENT_SIZE } from '../content/attachment-loader.js';

// Binary file magic bytes
const MAGIC_BYTES: [Buffer, string][] = [
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
  [Buffer.from([0x47, 0x49, 0x46]), 'image/gif'],
  [Buffer.from([0x25, 0x50, 0x44, 0x46]), 'application/pdf'],
  [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip'],
];

// OOXML and ODF documents are ZIP containers, so the PK magic alone cannot
// distinguish them from a plain archive. Disambiguate by extension (#98).
const ZIP_CONTAINER_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};

/**
 * Detect MIME type from file content magic bytes.
 *
 * Specific magic matches (jpeg/png/gif/pdf) win over `declaredType` — content
 * is authoritative when it identifies one concrete format. A ZIP match is only
 * a container signature, so it defers to `declaredType`, then to the filename
 * extension for known ZIP-based document formats (docx/xlsx/pptx/ODF).
 */
export function detectMimeType(content: Buffer, declaredType?: string, filename?: string): string {
  for (const [magic, mimeType] of MAGIC_BYTES) {
    if (content.length >= magic.length && content.subarray(0, magic.length).equals(magic)) {
      if (mimeType !== 'application/zip') {
        return mimeType;
      }
      if (declaredType) {
        return declaredType;
      }
      const ext = filename ? extname(filename).toLowerCase() : '';
      return ZIP_CONTAINER_TYPES[ext] ?? mimeType;
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
  original_filename: z.string(),
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
      original_filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      contentId: a.contentId,
      isInline: a.isInline,
    }));
    return { attachments };
  },
};

// Download a single attachment as inline base64
const DownloadAttachmentInput = z.object({
  message_id: z.string(),
  attachment_id: z.string(),
  mailbox: z.string().optional(),
  max_size_mb: z.number().int().positive().max(25).optional().default(5),
});

const DownloadAttachmentOutput = z.object({
  success: z.boolean(),
  filename: z.string().optional(),
  original_filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  base64: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }).optional(),
});

export const downloadAttachmentAction: EmailAction<
  z.infer<typeof DownloadAttachmentInput>,
  z.infer<typeof DownloadAttachmentOutput>
> = {
  name: 'download_attachment',
  description: 'Download a single attachment as inline base64. Default max_size_mb=5 (hard ceiling 25). File attachments only — Microsoft item/reference attachments return NOT_SUPPORTED.',
  input: DownloadAttachmentInput,
  output: DownloadAttachmentOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    if (typeof ctx.provider.downloadAttachment !== 'function') {
      return {
        success: false,
        error: {
          code: 'NOT_SUPPORTED',
          message: 'Provider does not support attachment download',
          recoverable: false,
        },
      };
    }

    const cap = input.max_size_mb * 1024 * 1024;
    let downloaded;
    try {
      downloaded = await ctx.provider.downloadAttachment(input.message_id, input.attachment_id);
    } catch (err) {
      if (err instanceof AttachmentNotSupportedError) {
        return {
          success: false,
          error: { code: 'NOT_SUPPORTED', message: err.message, recoverable: false },
        };
      }
      if (err instanceof AttachmentNotFoundError) {
        return {
          success: false,
          error: { code: 'ATTACHMENT_NOT_FOUND', message: err.message, recoverable: false },
        };
      }
      throw err;
    }

    if (downloaded.size > cap || downloaded.content.length > cap) {
      return {
        success: false,
        error: {
          code: 'ATTACHMENT_TOO_LARGE',
          message: `Attachment is ${downloaded.size} bytes; exceeds max_size_mb=${input.max_size_mb} (${cap} bytes)`,
          recoverable: false,
        },
      };
    }

    return {
      success: true,
      filename: sanitizeFilename(downloaded.filename),
      original_filename: downloaded.filename,
      mimeType: downloaded.mimeType,
      size: downloaded.content.length,
      base64: downloaded.content.toString('base64'),
    };
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

  const detectedMimeType = detectMimeType(content, declaredMimeType, filename);

  return { valid: true, detectedMimeType };
}
