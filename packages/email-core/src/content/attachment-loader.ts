// Sandboxed binary file reader for outbound attachments.
// Shares the path-traversal / symlink policy with body-loader via
// assertPathInSafeDir, but reads raw bytes — no text-extension gate, no
// null-byte rejection, no UTF-8 decode, no frontmatter parsing.
import { open } from 'node:fs/promises';
import { assertPathInSafeDir } from './safe-path.js';

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

export interface AttachmentFileResult {
  content?: Buffer;
  error?: { code: string; message: string; recoverable: boolean };
}

/** Map a Node filesystem error to a structured AttachmentFileResult error. */
function mapFsError(err: unknown, filePath: string): AttachmentFileResult {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ENOENT') {
    return { error: { code: 'FILE_NOT_FOUND', message: `attachment path not found: ${filePath}`, recoverable: false } };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { error: { code: 'PERMISSION_DENIED', message: `attachment path is not readable: ${filePath}`, recoverable: false } };
  }
  if (code === 'EISDIR') {
    return { error: { code: 'INVALID_FILE_TYPE', message: `attachment path is not a regular file: ${filePath}`, recoverable: false } };
  }
  return {
    error: {
      code: 'ATTACHMENT_READ_FAILED',
      message: `could not read attachment ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: false,
    },
  };
}

/**
 * Resolve and read an attachment file from disk, sandboxed to `safeDir`.
 * Rejects path traversal, symlink escape, missing files, non-files, and
 * files larger than MAX_ATTACHMENT_SIZE. Size is checked via fstat on an
 * open file descriptor and the bytes are read from that same descriptor, so
 * the check and read cannot race against a file swap. Never throws — all
 * filesystem errors are mapped to a structured error result.
 */
export async function resolveAttachmentFile(
  filePath: string,
  safeDir?: string,
): Promise<AttachmentFileResult> {
  const pathCheck = await assertPathInSafeDir(filePath, safeDir, 'attachment path');
  if (pathCheck.error) {
    return { error: pathCheck.error };
  }
  const resolved = pathCheck.resolved!;

  let filehandle;
  try {
    filehandle = await open(resolved, 'r');
    const fileStat = await filehandle.stat();

    if (!fileStat.isFile()) {
      return {
        error: {
          code: 'INVALID_FILE_TYPE',
          message: `attachment path is not a regular file: ${filePath}`,
          recoverable: false,
        },
      };
    }

    // Reject oversize before reading the whole file into memory.
    if (fileStat.size > MAX_ATTACHMENT_SIZE) {
      return {
        error: {
          code: 'ATTACHMENT_TOO_LARGE',
          message: `Attachment exceeds maximum size of 25MB: ${filePath}`,
          recoverable: false,
        },
      };
    }

    const content = await filehandle.readFile();
    return { content };
  } catch (err) {
    return mapFsError(err, filePath);
  } finally {
    await filehandle?.close();
  }
}
