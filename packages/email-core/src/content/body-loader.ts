// Shared body-file resolution — safe file loading with frontmatter support
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { parseFrontmatter, type FrontmatterFields } from './frontmatter.js';

export const BODY_SIZE_LIMIT = 3.5 * 1024 * 1024; // 3.5MB
export const TEXT_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.text']);

export interface BodyFileResult {
  content?: string;
  frontmatter?: FrontmatterFields;
  error?: { code: string; message: string; recoverable: boolean };
}

export async function resolveBodyFile(
  bodyFile: string,
  safeDir?: string,
): Promise<BodyFileResult> {
  const baseDir = safeDir ?? process.cwd();
  const resolved = resolve(baseDir, bodyFile);

  // Check path traversal
  if (bodyFile.includes('..') || (isAbsolute(bodyFile) && !resolved.startsWith(baseDir))) {
    return {
      error: {
        code: 'PATH_TRAVERSAL',
        message: 'body_file must be within the working directory',
        recoverable: false,
      },
    };
  }

  // Verify it's within the safe directory
  const rel = relative(baseDir, resolved);
  if (rel.startsWith('..')) {
    return {
      error: {
        code: 'PATH_TRAVERSAL',
        message: 'body_file must be within the working directory',
        recoverable: false,
      },
    };
  }

  // Check if file exists and is not a symlink escape
  try {
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink()) {
      const realPath = await realpath(resolved);
      if (!realPath.startsWith(baseDir)) {
        return {
          error: {
            code: 'SYMLINK_ESCAPE',
            message: 'body_file symlink targets outside working directory',
            recoverable: false,
          },
        };
      }
    }
  } catch {
    return {
      error: {
        code: 'FILE_NOT_FOUND',
        message: `body_file not found: ${bodyFile}`,
        recoverable: false,
      },
    };
  }

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

  // Read file and check for binary content
  const raw = await readFile(resolved);

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
