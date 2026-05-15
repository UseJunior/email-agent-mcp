// Shared sandbox policy for file reads (body_file, attachment paths).
// Resolves a caller-supplied path against a safe base directory and rejects
// path traversal and symlink escapes. Used by body-loader and
// attachment-loader so both file-read surfaces share one policy.
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export interface SafePathError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface SafePathResult {
  resolved?: string;
  error?: SafePathError;
}

/** True when `target` is `base` itself or a descendant of it. */
function isWithin(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve `filePath` within `safeDir` and verify it does not escape that
 * directory via `..` segments, an absolute path, or a symlink (leaf OR an
 * ancestor directory). Both the base directory and the fully resolved target
 * are canonicalized with `realpath` before the containment check, so a
 * symlink anywhere in the chain that points outside the sandbox is caught —
 * and the comparison is a true path-segment containment test, not a string
 * prefix (so a sibling like `<safeDir>-evil` cannot pass).
 *
 * `fieldName` is interpolated into error messages (e.g. "body_file",
 * "attachment path") so callers get a field-specific message.
 */
export async function assertPathInSafeDir(
  filePath: string,
  safeDir: string | undefined,
  fieldName: string,
): Promise<SafePathResult> {
  const baseDir = resolve(safeDir ?? process.cwd());
  const resolved = resolve(baseDir, filePath);

  // Cheap literal pre-check before touching the filesystem.
  if (filePath.includes('..') || !isWithin(baseDir, resolved)) {
    return {
      error: {
        code: 'PATH_TRAVERSAL',
        message: `${fieldName} must be within the working directory`,
        recoverable: false,
      },
    };
  }

  // Canonicalize the target — realpath resolves every symlink in the path,
  // so a leaf or intermediate-directory symlink escape surfaces here.
  let realResolved: string;
  try {
    realResolved = await realpath(resolved);
  } catch {
    return {
      error: {
        code: 'FILE_NOT_FOUND',
        message: `${fieldName} not found: ${filePath}`,
        recoverable: false,
      },
    };
  }

  // Canonicalize the base too — the sandbox root itself may live under a
  // symlink (e.g. macOS /var → /private/var), so both sides must be real.
  let realBase: string;
  try {
    realBase = await realpath(baseDir);
  } catch {
    realBase = baseDir;
  }

  if (!isWithin(realBase, realResolved)) {
    return {
      error: {
        code: 'SYMLINK_ESCAPE',
        message: `${fieldName} symlink targets outside working directory`,
        recoverable: false,
      },
    };
  }

  return { resolved: realResolved };
}
