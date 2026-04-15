// Attachment resolution — safe file loading for outbound email attachments.
//
// Security model:
// - Files must live inside EMAIL_AGENT_MCP_ATTACHMENT_DIR (env var).
// - The env var must be set, absolute, and point to an existing directory —
//   fail closed with a distinct error code for each failure mode.
// - Paths are resolved through `fs.realpath` on both the base dir and the
//   candidate, then compared via `path.relative()` to catch sibling-prefix
//   attacks (e.g. `/allowed-evil/x` vs base `/allowed`).
// - Per-file size cap is 3 MiB. Zero-byte files are allowed.
// - When two different paths resolve to the same realpath (duplicate or
//   symlink alias), only the first occurrence is kept.
// - When two different realpaths share the same basename, later ones are
//   disambiguated with ` (2)`, ` (3)` suffixes before the extension.
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import type { OutboundAttachment } from '../types.js';
import { isPathInsideDir } from './safe-path.js';

export const ATTACHMENT_MAX_SIZE = 3 * 1024 * 1024; // 3 MiB
export const ATTACHMENT_DIR_ENV = 'EMAIL_AGENT_MCP_ATTACHMENT_DIR';

export interface AttachmentLoaderError {
  code:
    | 'ATTACHMENT_DIR_NOT_CONFIGURED'
    | 'ATTACHMENT_DIR_NOT_ABSOLUTE'
    | 'ATTACHMENT_DIR_NOT_FOUND'
    | 'ATTACHMENT_NOT_FOUND'
    | 'ATTACHMENT_NOT_ALLOWED'
    | 'ATTACHMENT_TOO_LARGE';
  message: string;
  recoverable: false;
}

export interface AttachmentLoaderResult {
  attachments?: OutboundAttachment[];
  error?: AttachmentLoaderError;
}

/**
 * Resolve and load a list of attachment paths. Returns either
 * `{ attachments }` on success or `{ error }` on the first failure — this is
 * an all-or-nothing operation (we don't want to half-attach a draft).
 *
 * An empty input list returns `{ attachments: [] }` without consulting the
 * env var — the caller may not have attachments at all, in which case we
 * shouldn't demand the dir be configured.
 */
export async function resolveAttachments(paths: readonly string[]): Promise<AttachmentLoaderResult> {
  if (paths.length === 0) {
    return { attachments: [] };
  }

  const configured = process.env[ATTACHMENT_DIR_ENV];
  if (!configured) {
    return {
      error: {
        code: 'ATTACHMENT_DIR_NOT_CONFIGURED',
        message: `${ATTACHMENT_DIR_ENV} must be set to an absolute directory path to use outbound attachments`,
        recoverable: false,
      },
    };
  }
  if (!isAbsolute(configured)) {
    return {
      error: {
        code: 'ATTACHMENT_DIR_NOT_ABSOLUTE',
        message: `${ATTACHMENT_DIR_ENV} must be an absolute path, got: ${configured}`,
        recoverable: false,
      },
    };
  }

  let baseReal: string;
  try {
    const st = await stat(configured);
    if (!st.isDirectory()) {
      return {
        error: {
          code: 'ATTACHMENT_DIR_NOT_FOUND',
          message: `${ATTACHMENT_DIR_ENV} is not a directory: ${configured}`,
          recoverable: false,
        },
      };
    }
    baseReal = await realpath(configured);
  } catch {
    return {
      error: {
        code: 'ATTACHMENT_DIR_NOT_FOUND',
        message: `${ATTACHMENT_DIR_ENV} directory does not exist: ${configured}`,
        recoverable: false,
      },
    };
  }

  // Map realpath → index in the output array, for dedupe.
  const realToIndex = new Map<string, number>();
  const out: OutboundAttachment[] = [];
  // Track used filenames so collisions across different realpaths get a
  // " (2)", " (3)" suffix — matches how native clients handle same-named
  // attachments.
  const usedFilenames = new Map<string, number>();

  for (const p of paths) {
    // Resolve against the attachment dir (treats relative paths as
    // attachment-dir-relative; absolute paths are kept as-is).
    const resolved = resolve(baseReal, p);

    let candidateReal: string;
    try {
      candidateReal = await realpath(resolved);
    } catch {
      return {
        error: {
          code: 'ATTACHMENT_NOT_FOUND',
          message: `Attachment file not found: ${p}`,
          recoverable: false,
        },
      };
    }

    if (!isPathInsideDir(candidateReal, baseReal)) {
      return {
        error: {
          code: 'ATTACHMENT_NOT_ALLOWED',
          message: `Attachment path is outside ${ATTACHMENT_DIR_ENV}: ${p}`,
          recoverable: false,
        },
      };
    }

    // Dedupe: if we've already loaded this realpath, skip.
    if (realToIndex.has(candidateReal)) {
      continue;
    }

    let fileStat;
    try {
      fileStat = await stat(candidateReal);
    } catch {
      return {
        error: {
          code: 'ATTACHMENT_NOT_FOUND',
          message: `Attachment file not found: ${p}`,
          recoverable: false,
        },
      };
    }

    if (fileStat.size > ATTACHMENT_MAX_SIZE) {
      return {
        error: {
          code: 'ATTACHMENT_TOO_LARGE',
          message: `Attachment ${basename(p)} is ${fileStat.size} bytes — exceeds ${ATTACHMENT_MAX_SIZE} byte limit`,
          recoverable: false,
        },
      };
    }

    const content = await readFile(candidateReal);
    const rawName = basename(candidateReal);
    const filename = disambiguateFilename(rawName, usedFilenames);
    const mimeType = lookupMime(rawName) || 'application/octet-stream';

    realToIndex.set(candidateReal, out.length);
    out.push({ filename, content, mimeType });
  }

  return { attachments: out };
}

/**
 * If `raw` has already been used, return `raw` with a ` (2)`, ` (3)` suffix
 * inserted before the extension. Mutates `used` so subsequent calls see the
 * updated counts.
 */
function disambiguateFilename(raw: string, used: Map<string, number>): string {
  const existing = used.get(raw);
  if (existing === undefined) {
    used.set(raw, 1);
    return raw;
  }
  const next = existing + 1;
  used.set(raw, next);
  const ext = extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  const candidate = `${stem} (${next})${ext}`;
  // If the candidate is itself already used, keep bumping.
  // Register the candidate too so the same input with the same count twice
  // doesn't produce a collision.
  used.set(candidate, 1);
  return candidate;
}
