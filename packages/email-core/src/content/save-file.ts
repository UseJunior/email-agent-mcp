// Sandboxed local-file materialization for inbound bytes (download_attachment
// `save_to`, download_message). The destination directory resolves under the
// same sandbox as body_file and outbound attachment paths — the safe base
// directory plus AGENT_EMAIL_ALLOWED_DIRS roots — so inbound and outbound files
// share one policy. Bytes are written inside the server and never returned to
// the caller, keeping large base64 payloads out of the agent's context (#169).
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  canonicalize,
  isWithin,
  rootsHint,
  rootsOf,
  type PathSandboxInput,
  type SafePathResult,
} from './safe-path.js';

/**
 * Open flags for a new file. `O_EXCL` refuses any existing entry — including a
 * planted symlink at the leaf — so a write can never follow a link out of the
 * sandbox or clobber an existing file. `O_NOFOLLOW` is belt-and-braces where
 * the platform has it.
 */
const SAFE_CREATE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

/** Collision suffixes tried (`name-1.ext` … `name-N.ext`) before giving up. */
const MAX_COLLISION_SUFFIX = 999;

export interface SavedFile {
  path: string;
  filename: string;
  size: number;
  sha256: string;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Resolve `saveTo` to a canonical directory inside the sandbox, creating any
 * missing segments. A RELATIVE path resolves against the safe base directory
 * only; an ABSOLUTE path may land in any root (first containment match wins) —
 * the same rule `assertPathInSafeDir` applies to reads. The nearest existing
 * ancestor is canonicalized before anything is created, and the final
 * directory is canonicalized again afterwards, so a symlink anywhere in the
 * chain that leads outside every root is rejected with `SYMLINK_ESCAPE`.
 */
export async function resolveSaveDir(
  saveTo: string,
  sandbox: PathSandboxInput,
  fieldName = 'save_to',
): Promise<SafePathResult> {
  const roots = rootsOf(sandbox);
  const scope = roots.length === 1 ? 'the working directory' : 'an allowed directory';
  const fail = (code: string, message: string): SafePathResult => ({
    error: { code, message, recoverable: false },
  });
  const traversalError = () =>
    fail('PATH_TRAVERSAL', `${fieldName} must be within ${scope}${rootsHint(roots)}`);

  if (saveTo.trim() === '') return fail('INVALID_PATH', `${fieldName} must not be empty`);
  if (saveTo.startsWith('~')) {
    return fail(
      'INVALID_PATH',
      `${fieldName} must be relative to the working directory or an absolute path; a leading ~ is not expanded${rootsHint(roots)}`,
    );
  }
  if (saveTo.includes('..')) return traversalError();

  const searchRoots = isAbsolute(saveTo) ? roots : roots.slice(0, 1);
  const candidates = searchRoots
    .map(root => ({ root, target: resolve(root, saveTo) }))
    .filter(({ root, target }) => isWithin(root, target));
  if (candidates.length === 0) return traversalError();

  const realRoots = (await Promise.all(roots.map(canonicalize))).filter(
    (real): real is string => real !== null,
  );
  const contained = (real: string) => realRoots.some(realRoot => isWithin(realRoot, real));

  let sawEscape = false;
  for (const { root, target } of candidates) {
    // Walk up to the nearest existing ancestor (at most the root itself).
    let existing = target;
    const missing: string[] = [];
    let realExisting: string | null = null;
    for (;;) {
      try {
        realExisting = await realpath(existing);
        break;
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT' || existing === root || dirname(existing) === existing) break;
        missing.unshift(basename(existing));
        existing = dirname(existing);
      }
    }
    if (realExisting === null) continue; // Root itself is unusable; try the next.
    if (!contained(realExisting)) {
      sawEscape = true;
      continue;
    }

    // Create missing segments one at a time beneath the canonical ancestor,
    // owner-only, since the contents are mailbox data.
    let dir = realExisting;
    try {
      for (const segment of missing) {
        dir = join(dir, segment);
        try {
          await mkdir(dir, { mode: 0o700 });
        } catch (err) {
          if (errnoCode(err) !== 'EEXIST') throw err;
        }
      }
    } catch (err) {
      return fail('SAVE_FAILED', `${fieldName} could not be created: ${(err as Error).message}`);
    }

    // Re-canonicalize: an entry that appeared concurrently (EEXIST) may be a
    // symlink, and only the final real path proves containment.
    let realDir: string;
    try {
      realDir = await realpath(dir);
    } catch (err) {
      return fail('SAVE_FAILED', `${fieldName} could not be resolved: ${(err as Error).message}`);
    }
    if (!contained(realDir)) {
      sawEscape = true;
      continue;
    }
    if (!(await stat(realDir)).isDirectory()) {
      return fail('NOT_A_DIRECTORY', `${fieldName} must name a directory: ${saveTo}`);
    }
    return { resolved: realDir };
  }

  if (sawEscape) {
    const escaped = roots.length === 1 ? 'working directory' : 'the allowed directories';
    return fail('SYMLINK_ESCAPE', `${fieldName} symlink targets outside ${escaped}${rootsHint(roots)}`);
  }
  return fail('PATH_NOT_FOUND', `${fieldName} root could not be resolved: ${saveTo}${rootsHint(roots)}`);
}

/**
 * Harden an already-sanitized display filename for use as an on-disk leaf:
 * strip anything but `[A-Za-z0-9.]` from the extension, drop leading dots (no
 * hidden files), cap the length, and fall back when nothing usable is left.
 */
export function toDiskFilename(name: string, fallback: string, forcedExt?: string): string {
  // A forced extension is appended, not substituted: a subject such as
  // "Agreement v2.1" keeps its ".1".
  const rawExt = forcedExt === undefined ? extname(name) : '';
  const ext = forcedExt ?? rawExt.replace(/[^A-Za-z0-9.]/g, '').slice(0, 16);
  const collapsed = (rawExt ? name.slice(0, -rawExt.length) : name)
    .replace(/[^A-Za-z0-9._\- ]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
  const stem = trimEdges(collapsed).slice(0, 150);
  return (stem || fallback) + (ext === '.' ? '' : ext);
}

/**
 * Drop leading `.`/`_` and trailing `_`. A linear scan rather than an anchored
 * regex such as `/_+$/`, which backtracks polynomially on long `_` runs.
 */
function trimEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '.' || value[start] === '_')) start++;
  while (end > start && value[end - 1] === '_') end--;
  return value.slice(start, end);
}

/**
 * Write `content` to `dir/filename` without ever overwriting. On collision the
 * name gains a deterministic numeric suffix (`report.pdf`, `report-1.pdf`,
 * `report-2.pdf`, …). The file is created owner-only (0600). A failed write
 * removes the partial file. The returned size and SHA-256 describe exactly the
 * bytes written.
 */
export async function writeFileExclusive(
  dir: string,
  filename: string,
  content: Buffer,
): Promise<SavedFile> {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;

  for (let n = 0; n <= MAX_COLLISION_SUFFIX; n++) {
    const name = n === 0 ? filename : `${stem}-${n}${ext}`;
    const path = join(dir, name);
    let handle;
    try {
      handle = await open(path, SAFE_CREATE_FLAGS, 0o600);
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') continue;
      throw err;
    }
    try {
      await handle.writeFile(content);
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw err;
    }
    return {
      path,
      filename: name,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }
  throw new Error(
    `Could not find a free filename for ${filename} in ${dir} after ${MAX_COLLISION_SUFFIX} attempts`,
  );
}
