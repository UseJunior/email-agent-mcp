// Shared body-file resolution — safe file loading with frontmatter support
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseFrontmatter, type FrontmatterFields } from './frontmatter.js';
import { assertPathInSafeDir, SAFE_READ_FLAGS, type PathSandboxInput } from './safe-path.js';

export const BODY_SIZE_LIMIT = 3.5 * 1024 * 1024; // 3.5MB
export const TEXT_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.text']);

export interface BodyFileResult {
  content?: string;
  frontmatter?: FrontmatterFields;
  error?: { code: string; message: string; recoverable: boolean };
}

export async function resolveBodyFile(
  bodyFile: string,
  sandbox?: PathSandboxInput,
): Promise<BodyFileResult> {
  const pathCheck = await assertPathInSafeDir(bodyFile, sandbox, 'body_file');
  if (pathCheck.error) {
    return { error: pathCheck.error };
  }
  const resolved = pathCheck.resolved!;

  // Check file extension
  const ext = extname(resolved).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) {
    return {
      error: {
        code: 'INVALID_FILE_TYPE',
        message: 'body_file must be a text file (.md, .html, .txt)',
        recoverable: false,
      },
    };
  }

  // Read through an opened descriptor with O_NOFOLLOW, matching the
  // attachment loader: the validated leaf cannot be swapped for a symlink
  // between the containment check and the read.
  let raw: Buffer;
  let filehandle;
  try {
    filehandle = await open(resolved, SAFE_READ_FLAGS);
    raw = await filehandle.readFile();
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ELOOP') {
      return {
        error: {
          code: 'SYMLINK_ESCAPE',
          message: `body_file changed to a symlink during validation: ${bodyFile}`,
          recoverable: false,
        },
      };
    }
    throw err;
  } finally {
    await filehandle?.close();
  }

  // Binary file detection: check for null bytes
  if (raw.includes(0)) {
    return {
      error: {
        code: 'BINARY_FILE',
        message: 'body_file must be a text file (.md, .html, .txt)',
        recoverable: false,
      },
    };
  }

  const textContent = raw.toString('utf-8');

  // Parse frontmatter from .md files
  if (ext === '.md') {
    const parsed = parseFrontmatter(textContent);
    return { content: parsed.body, frontmatter: parsed.frontmatter };
  }

  return { content: textContent };
}

export function truncateBody(body: string, maxBytes: number = BODY_SIZE_LIMIT): string {
  const truncationNotice = '\n\nThis response was truncated because it exceeded email size limits.';
  const targetSize = maxBytes - Buffer.byteLength(truncationNotice, 'utf-8');

  // Find a safe cut point — don't cut inside HTML tags
  const encoded = Buffer.from(body, 'utf-8');
  if (encoded.length <= maxBytes) return body;

  const truncated = encoded.subarray(0, targetSize).toString('utf-8');
  const lastTagClose = truncated.lastIndexOf('>');
  const lastNewline = truncated.lastIndexOf('\n');
  const safeCut = Math.max(lastTagClose + 1, lastNewline + 1, targetSize - 1000);

  return truncated.substring(0, safeCut) + truncationNotice;
}
