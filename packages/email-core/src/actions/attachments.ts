// Attachment handling actions
import { z } from 'zod';
import { extname } from 'node:path';
import type { EmailAction } from './registry.js';
import { AttachmentNotSupportedError, AttachmentNotFoundError, MessageNotFoundError } from '../providers/provider.js';
import { MAX_ATTACHMENT_SIZE } from '../content/attachment-loader.js';
import { resolveSaveDir, toDiskFilename, writeFileExclusive } from '../content/save-file.js';

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
export const ZIP_CONTAINER_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  '.dotm': 'application/vnd.ms-word.template.macroEnabled.12',
  '.xltm': 'application/vnd.ms-excel.template.macroEnabled.12',
  '.potm': 'application/vnd.ms-powerpoint.template.macroEnabled.12',
  '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.odg': 'application/vnd.oasis.opendocument.graphics',
  '.ott': 'application/vnd.oasis.opendocument.text-template',
  '.ots': 'application/vnd.oasis.opendocument.spreadsheet-template',
  '.otp': 'application/vnd.oasis.opendocument.presentation-template',
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
    const listed = typeof ctx.provider.listAttachments === 'function'
      ? await ctx.provider.listAttachments(input.message_id)
      : (await ctx.provider.getMessage(input.message_id)).attachments ?? [];
    const attachments = listed.map(a => ({
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

// Download a single attachment — inline base64 by default, or written to a
// sandboxed local directory with `save_to` (#169).
const DEFAULT_INLINE_SIZE_MB = 5;
const MAX_INLINE_SIZE_MB = 25;
// save_to keeps the bytes server-side, so the inline ceiling (which exists to
// protect the agent's context) does not apply. 150 MB is Outlook's largest
// attachment, uploaded via upload session.
export const MAX_SAVE_SIZE_MB = 150;

const SAVE_TO_DESCRIPTION =
  'Directory to write the file into instead of returning base64. Sandboxed like body_file and attachment paths: relative paths resolve against the working directory only; directories in an AGENT_EMAIL_ALLOWED_DIRS root must be given as an ABSOLUTE path (a leading ~ is not expanded). Missing subdirectories are created. Existing files are never overwritten — a collision gets a numeric suffix (report.pdf, report-1.pdf, …).';

const ActionError = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

const DownloadAttachmentInput = z.object({
  message_id: z.string(),
  attachment_id: z.string(),
  mailbox: z.string().optional(),
  max_size_mb: z.number().int().positive().max(MAX_SAVE_SIZE_MB).optional()
    .describe(`Size cap in MB. Inline default ${DEFAULT_INLINE_SIZE_MB}, inline ceiling ${MAX_INLINE_SIZE_MB}; with save_to the default and ceiling are ${MAX_SAVE_SIZE_MB}.`),
  save_to: z.string().optional().describe(SAVE_TO_DESCRIPTION),
  filename: z.string().optional()
    .describe('On-disk filename to use with save_to (sanitized). Defaults to the attachment\'s sanitized name.'),
});

const DownloadAttachmentOutput = z.object({
  success: z.boolean(),
  filename: z.string().optional(),
  original_filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  base64: z.string().optional(),
  path: z.string().optional(),
  sha256: z.string().optional(),
  error: ActionError.optional(),
});

type ActionErrorResult = { success: false; error: z.infer<typeof ActionError> };

function failure(code: string, message: string, recoverable = false): ActionErrorResult {
  return { success: false, error: { code, message, recoverable } };
}

export const downloadAttachmentAction: EmailAction<
  z.infer<typeof DownloadAttachmentInput>,
  z.infer<typeof DownloadAttachmentOutput>
> = {
  name: 'download_attachment',
  description: `Download a single attachment. By default returns inline base64 (max_size_mb default ${DEFAULT_INLINE_SIZE_MB}, ceiling ${MAX_INLINE_SIZE_MB}). Pass save_to to write the file to a sandboxed local directory instead and get back only {path, filename, mimeType, size, sha256} — use this for anything large (video, audio, big PDFs) or anything local tools need as a file. File attachments only — Microsoft item/reference attachments return NOT_SUPPORTED.`,
  input: DownloadAttachmentInput,
  output: DownloadAttachmentOutput,
  // Writes only to the local sandbox, never to the mailbox.
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    if (typeof ctx.provider.downloadAttachment !== 'function') {
      return failure('NOT_SUPPORTED', 'Provider does not support attachment download');
    }

    const saving = input.save_to !== undefined;
    if (!saving && input.filename !== undefined) {
      return failure('INVALID_ARGUMENT', 'filename is only valid together with save_to');
    }
    const maxMb = input.max_size_mb ?? (saving ? MAX_SAVE_SIZE_MB : DEFAULT_INLINE_SIZE_MB);
    if (!saving && maxMb > MAX_INLINE_SIZE_MB) {
      return failure(
        'INVALID_ARGUMENT',
        `max_size_mb=${maxMb} exceeds the inline ceiling of ${MAX_INLINE_SIZE_MB}; pass save_to to write larger attachments to disk`,
      );
    }

    // Resolve the destination before fetching any bytes, so a bad path fails
    // fast instead of after a large download.
    let saveDir: string | undefined;
    if (saving) {
      const resolved = await resolveSaveDir(input.save_to!, { safeDir: ctx.safeDir, allowedDirs: ctx.allowedDirs });
      if (resolved.error) return { success: false, error: resolved.error };
      saveDir = resolved.resolved;
    }

    const cap = maxMb * 1024 * 1024;
    let downloaded;
    try {
      downloaded = await ctx.provider.downloadAttachment(input.message_id, input.attachment_id);
    } catch (err) {
      if (err instanceof AttachmentNotSupportedError) {
        return failure('NOT_SUPPORTED', err.message);
      }
      if (err instanceof AttachmentNotFoundError) {
        return failure('ATTACHMENT_NOT_FOUND', err.message);
      }
      throw err;
    }

    // Provider-reported size is checked too: Graph's `size` can exceed the
    // decoded length (it counts MIME framing), and an honest cap errs on the
    // side of refusing.
    if (downloaded.size > cap || downloaded.content.length > cap) {
      const fitsOnDisk = downloaded.content.length <= MAX_SAVE_SIZE_MB * 1024 * 1024;
      const hint = !saving && fitsOnDisk
        ? '. Pass save_to to write it to disk instead of returning base64'
        : '';
      return failure(
        'ATTACHMENT_TOO_LARGE',
        `Attachment is ${downloaded.size} bytes; exceeds max_size_mb=${maxMb} (${cap} bytes)${hint}`,
        !saving && fitsOnDisk,
      );
    }

    const displayName = sanitizeFilename(downloaded.filename);
    if (saveDir === undefined) {
      return {
        success: true,
        filename: displayName,
        original_filename: downloaded.filename,
        mimeType: downloaded.mimeType,
        size: downloaded.content.length,
        base64: downloaded.content.toString('base64'),
      };
    }

    const diskName = toDiskFilename(sanitizeFilename(input.filename ?? downloaded.filename), 'attachment');
    let saved;
    try {
      saved = await writeFileExclusive(saveDir, diskName, downloaded.content);
    } catch (err) {
      return failure('SAVE_FAILED', `Could not write attachment: ${(err as Error).message}`);
    }
    return {
      success: true,
      path: saved.path,
      filename: saved.filename,
      original_filename: downloaded.filename,
      mimeType: downloaded.mimeType,
      size: saved.size,
      sha256: saved.sha256,
    };
  },
};

// Export a whole message as the raw RFC 822 bytes the provider stores — the
// as-received `.eml` that record-keeping workflows bank next to attachments.
// Always written to disk: a raw message carries every attachment, base64
// encoded, so returning it inline would defeat the point (#169).
const DownloadMessageInput = z.object({
  message_id: z.string(),
  mailbox: z.string().optional(),
  save_to: z.string().describe(SAVE_TO_DESCRIPTION),
  filename: z.string().optional()
    .describe('On-disk filename (sanitized; the extension is always .eml). Defaults to the message subject.'),
  max_size_mb: z.number().int().positive().max(MAX_SAVE_SIZE_MB).optional()
    .describe(`Size cap in MB. Default and ceiling ${MAX_SAVE_SIZE_MB}.`),
});

const DownloadMessageOutput = z.object({
  success: z.boolean(),
  path: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  sha256: z.string().optional(),
  error: ActionError.optional(),
});

export const downloadMessageAction: EmailAction<
  z.infer<typeof DownloadMessageInput>,
  z.infer<typeof DownloadMessageOutput>
> = {
  name: 'download_message',
  description: 'Save a whole message, as received, to a sandboxed local directory as a raw RFC 822 .eml file (Graph /$value, Gmail format=raw). Returns {path, filename, mimeType, size, sha256}, never the bytes. Use it to keep a record copy next to attachments saved with download_attachment save_to.',
  input: DownloadMessageInput,
  output: DownloadMessageOutput,
  // Writes only to the local sandbox, never to the mailbox.
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    if (typeof ctx.provider.getRawMessage !== 'function') {
      return failure('NOT_SUPPORTED', 'Provider does not support raw message export');
    }

    const resolved = await resolveSaveDir(input.save_to, { safeDir: ctx.safeDir, allowedDirs: ctx.allowedDirs });
    if (resolved.error) return { success: false, error: resolved.error };

    let raw: Buffer;
    try {
      raw = await ctx.provider.getRawMessage(input.message_id);
    } catch (err) {
      if (err instanceof MessageNotFoundError) {
        return failure('MESSAGE_NOT_FOUND', err.message);
      }
      throw err;
    }

    const maxMb = input.max_size_mb ?? MAX_SAVE_SIZE_MB;
    if (raw.length > maxMb * 1024 * 1024) {
      return failure('MESSAGE_TOO_LARGE', `Message is ${raw.length} bytes; exceeds max_size_mb=${maxMb}`);
    }

    let name = input.filename;
    if (name === undefined) {
      // Best-effort subject lookup for a readable default; a failed metadata
      // read must not fail an export whose bytes are already in hand.
      name = await ctx.provider.getMessage(input.message_id).then(m => m.subject, () => undefined) || 'message';
    }
    const diskName = toDiskFilename(sanitizeFilename(name), 'message', '.eml');

    let saved;
    try {
      saved = await writeFileExclusive(resolved.resolved!, diskName, raw);
    } catch (err) {
      return failure('SAVE_FAILED', `Could not write message: ${(err as Error).message}`);
    }
    return {
      success: true,
      path: saved.path,
      filename: saved.filename,
      mimeType: 'message/rfc822',
      size: saved.size,
      sha256: saved.sha256,
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
