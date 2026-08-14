// Shared sandbox policy for file reads (body_file, attachment paths).
// Resolves a caller-supplied path against the safe base directory — plus any
// operator-allowlisted extra roots — and rejects path traversal and symlink
// escapes. Used by body-loader and attachment-loader so both file-read
// surfaces share one policy.
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, delimiter } from 'node:path';

/** Env var that adds trusted roots beyond the safe base directory. */
export const ALLOWED_DIRS_ENV = 'AGENT_EMAIL_ALLOWED_DIRS';

export interface SafePathError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface SafePathResult {
  resolved?: string;
  error?: SafePathError;
}

/**
 * Filesystem sandbox for caller-supplied paths: the primary root that relative
 * paths resolve against, plus extra operator-allowlisted roots. A bare string
 * is accepted as shorthand for `{ safeDir }`.
 */
export interface PathSandbox {
  safeDir?: string;
  allowedDirs?: readonly string[];
}

export type PathSandboxInput = string | PathSandbox | undefined;

/** True when `target` is `base` itself or a descendant of it. */
function isWithin(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Canonicalize a root, falling back to the literal path when it does not exist. */
async function canonicalize(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return dir;
  }
}

/**
 * Parse a delimiter-separated list of extra allowed roots (the
 * `AGENT_EMAIL_ALLOWED_DIRS` env var). Entries are split on the platform path
 * delimiter (`:` on POSIX, `;` on Windows), trimmed, `~`-expanded, and
 * deduplicated. Non-absolute entries are dropped with a warning rather than
 * silently resolved against the process working directory, since an operator
 * writing a relative root almost certainly means a different directory than
 * whatever cwd the server happens to start in.
 */
export function parseAllowedDirs(
  raw: string | undefined,
  opts?: { home?: string },
): { dirs: string[]; warnings: string[] } {
  const home = opts?.home ?? homedir();
  const dirs: string[] = [];
  const warnings: string[] = [];

  for (const entry of (raw ?? '').split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const expanded =
      trimmed === '~' ? home
      : trimmed.startsWith('~/') ? resolve(home, trimmed.slice(2))
      : trimmed;

    if (!isAbsolute(expanded)) {
      warnings.push(`ignoring non-absolute ${ALLOWED_DIRS_ENV} entry: ${trimmed}`);
      continue;
    }

    // `resolve` on an already-absolute path only normalizes it — collapsing
    // `.` segments and a trailing slash — so `/a/b/` and `/a/b` dedupe.
    const normalized = resolve(expanded);
    if (!dirs.includes(normalized)) dirs.push(normalized);
  }

  return { dirs, warnings };
}

/** Normalize the sandbox shorthand into an ordered, deduplicated root list. */
function rootsOf(sandbox: PathSandboxInput): string[] {
  const { safeDir, allowedDirs } =
    typeof sandbox === 'string' ? { safeDir: sandbox, allowedDirs: undefined } : (sandbox ?? {});

  const roots = [resolve(safeDir ?? process.cwd())];
  for (const dir of allowedDirs ?? []) {
    const resolved = resolve(dir);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

/**
 * Resolve `filePath` within the sandbox and verify it does not escape via `..`
 * segments, an absolute path outside every root, or a symlink (leaf OR an
 * ancestor directory). Roots are tried in order — the safe base directory
 * first, then each configured extra root — and the first containment match
 * wins. Both every root and the fully resolved target are canonicalized with
 * `realpath` before the containment check, so a symlink anywhere in the chain
 * that points outside every root is caught — and the comparison is a true
 * path-segment containment test, not a string prefix (so a sibling like
 * `<safeDir>-evil` cannot pass).
 *
 * A symlink that lands inside *another* allowlisted root is accepted: the
 * operator has already declared that directory trusted, so which root the
 * caller entered through does not change what they are permitted to read.
 *
 * `fieldName` is interpolated into error messages (e.g. "body_file",
 * "attachment path") so callers get a field-specific message.
 */
export async function assertPathInSafeDir(
  filePath: string,
  sandbox: PathSandboxInput,
  fieldName: string,
): Promise<SafePathResult> {
  const roots = rootsOf(sandbox);
  const scope =
    roots.length === 1 ? 'the working directory' : 'an allowed directory';
  const traversalError = (): SafePathResult => ({
    error: {
      code: 'PATH_TRAVERSAL',
      message: `${fieldName} must be within ${scope}${rootsHint(roots)}`,
      recoverable: false,
    },
  });

  // Cheap literal pre-check before touching the filesystem.
  if (filePath.includes('..')) return traversalError();

  const candidates = roots
    .map(root => ({ root, target: resolve(root, filePath) }))
    .filter(({ root, target }) => isWithin(root, target));
  if (candidates.length === 0) return traversalError();

  const realRoots = await Promise.all(roots.map(canonicalize));

  let sawEscape = false;
  for (const { target } of candidates) {
    // Canonicalize the target — realpath resolves every symlink in the path,
    // so a leaf or intermediate-directory symlink escape surfaces here.
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch {
      continue; // Missing under this root; a later root may still hold it.
    }

    // Roots are canonicalized too — a sandbox root may itself live under a
    // symlink (e.g. macOS /var → /private/var), so both sides must be real.
    if (realRoots.some(realRoot => isWithin(realRoot, realTarget))) {
      return { resolved: realTarget };
    }
    sawEscape = true;
  }

  if (sawEscape) {
    const escaped =
      roots.length === 1 ? 'working directory' : 'the allowed directories';
    return {
      error: {
        code: 'SYMLINK_ESCAPE',
        message: `${fieldName} symlink targets outside ${escaped}${rootsHint(roots)}`,
        recoverable: false,
      },
    };
  }

  return {
    error: {
      code: 'FILE_NOT_FOUND',
      message: `${fieldName} not found: ${filePath}`,
      recoverable: false,
    },
  };
}

/**
 * Trailing hint naming every root the path was checked against, plus the env
 * var that widens the sandbox. A bare "must be within the working directory"
 * gave no indication that configuration could permit the path, leaving callers
 * to guess (or to stage confidential files inside the working directory).
 */
function rootsHint(roots: string[]): string {
  const tried = roots.length === 1 ? roots[0] : `tried: ${roots.join(', ')}`;
  return ` (${tried}); set ${ALLOWED_DIRS_ENV} to allow other directories`;
}
