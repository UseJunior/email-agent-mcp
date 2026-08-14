// Sandbox policy coverage for body_file / attachment path reads, including the
// operator-configured extra roots added for issue #105.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter, sep } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertPathInSafeDir, parseAllowedDirs, ALLOWED_DIRS_ENV } from './safe-path.js';

let root: string;
let workDir: string;
let extraDir: string;
let outsideDir: string;

/** Skip a symlink assertion on platforms/filesystems that refuse symlinks. */
async function trySymlink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'safe-path-test-'));
  workDir = join(root, 'work');
  extraDir = join(root, 'extra');
  outsideDir = join(root, 'outside');
  await mkdir(workDir, { recursive: true });
  await mkdir(extraDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('content/safe-path — default single-root sandbox', () => {
  it('resolves a file inside the safe directory', async () => {
    await writeFile(join(workDir, 'draft.md'), 'body');
    const result = await assertPathInSafeDir('draft.md', workDir, 'body_file');
    expect(result.error).toBeUndefined();
    expect(result.resolved!.endsWith(`${sep}draft.md`)).toBe(true);
  });

  it('rejects an outside path when no extra roots are configured', async () => {
    await writeFile(join(extraDir, 'secret.pdf'), 'data');

    const asString = await assertPathInSafeDir(join(extraDir, 'secret.pdf'), workDir, 'attachment path');
    const asSandbox = await assertPathInSafeDir(
      join(extraDir, 'secret.pdf'),
      { safeDir: workDir },
      'attachment path',
    );

    expect(asString.error!.code).toBe('PATH_TRAVERSAL');
    expect(asSandbox.error!.code).toBe('PATH_TRAVERSAL');
    // Legacy wording is preserved so existing callers keep matching on it.
    expect(asString.error!.message).toContain('attachment path must be within the working directory');
  });

  it('names the working directory and the env var on rejection', async () => {
    const result = await assertPathInSafeDir('/etc/passwd', workDir, 'attachment path');
    expect(result.error!.message).toContain(workDir);
    expect(result.error!.message).toContain(ALLOWED_DIRS_ENV);
  });

  it('rejects a symlink escape with the legacy message', async () => {
    const target = join(outsideDir, 'secret.txt');
    await writeFile(target, 'secret');
    if (!(await trySymlink(target, join(workDir, 'escape.md')))) return;

    const result = await assertPathInSafeDir('escape.md', workDir, 'body_file');
    expect(result.error!.code).toBe('SYMLINK_ESCAPE');
    expect(result.error!.message).toContain('body_file symlink targets outside working directory');
  });
});

describe('content/safe-path — configured extra roots', () => {
  it('resolves a path inside a configured extra root', async () => {
    const file = join(extraDir, 'contract.pdf');
    await writeFile(file, 'data');

    const result = await assertPathInSafeDir(
      file,
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );

    expect(result.error).toBeUndefined();
    expect(result.resolved!.endsWith(`${sep}contract.pdf`)).toBe(true);
  });

  it('rejects a path outside every root with PATH_TRAVERSAL', async () => {
    const file = join(outsideDir, 'contract.pdf');
    await writeFile(file, 'data');

    const result = await assertPathInSafeDir(
      file,
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );

    expect(result.error!.code).toBe('PATH_TRAVERSAL');
    expect(result.error!.message).toContain('must be within an allowed directory');
    expect(result.error!.message).toContain(workDir);
    expect(result.error!.message).toContain(extraDir);
  });

  it('rejects a symlink inside a configured root that targets outside every root', async () => {
    const target = join(outsideDir, 'secret.txt');
    await writeFile(target, 'secret');
    const link = join(extraDir, 'escape.pdf');
    if (!(await trySymlink(target, link))) return;

    const result = await assertPathInSafeDir(
      link,
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );

    expect(result.error!.code).toBe('SYMLINK_ESCAPE');
    expect(result.error!.message).toContain(extraDir);
  });

  it('accepts a symlink in one allowed root that targets another allowed root', async () => {
    const target = join(extraDir, 'contract.pdf');
    await writeFile(target, 'data');
    const link = join(workDir, 'contract.pdf');
    if (!(await trySymlink(target, link))) return;

    const result = await assertPathInSafeDir(
      'contract.pdf',
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );

    expect(result.error).toBeUndefined();
    expect(result.resolved!.endsWith(`${sep}contract.pdf`)).toBe(true);
  });

  it('canonicalizes an allowed root that is itself a symlink', async () => {
    const realRoot = join(root, 'real-root');
    await mkdir(realRoot, { recursive: true });
    await writeFile(join(realRoot, 'contract.pdf'), 'data');
    const linkedRoot = join(root, 'linked-root');
    if (!(await trySymlink(realRoot, linkedRoot))) return;

    const result = await assertPathInSafeDir(
      join(linkedRoot, 'contract.pdf'),
      { safeDir: workDir, allowedDirs: [linkedRoot] },
      'attachment path',
    );

    expect(result.error).toBeUndefined();
    expect(result.resolved).toContain('real-root');
  });

  it('still rejects `..` traversal out of an allowed root', async () => {
    await writeFile(join(outsideDir, 'secret.txt'), 'secret');
    const result = await assertPathInSafeDir(
      join(extraDir, '..', 'outside', 'secret.txt'),
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );
    expect(result.error!.code).toBe('PATH_TRAVERSAL');
  });

  it('rejects a sibling directory whose name merely prefixes an allowed root', async () => {
    const evil = `${extraDir}-evil`;
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, 'secret.txt'), 'secret');

    const result = await assertPathInSafeDir(
      join(evil, 'secret.txt'),
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );

    expect(result.error!.code).toBe('PATH_TRAVERSAL');
  });

  it('reports FILE_NOT_FOUND when the path is allowed but absent', async () => {
    const result = await assertPathInSafeDir(
      join(extraDir, 'missing.pdf'),
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );
    expect(result.error!.code).toBe('FILE_NOT_FOUND');
  });

  it('falls through to a later root when a relative path is missing in the first', async () => {
    await writeFile(join(extraDir, 'contract.pdf'), 'data');
    const result = await assertPathInSafeDir(
      'contract.pdf',
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );
    expect(result.error).toBeUndefined();
    expect(result.resolved).toContain('extra');
  });

  it('prefers the safe directory over a later root for the same relative path', async () => {
    await writeFile(join(workDir, 'contract.pdf'), 'work copy');
    await writeFile(join(extraDir, 'contract.pdf'), 'extra copy');
    const result = await assertPathInSafeDir(
      'contract.pdf',
      { safeDir: workDir, allowedDirs: [extraDir] },
      'attachment path',
    );
    expect(result.error).toBeUndefined();
    expect(result.resolved).toContain('work');
  });
});

describe('content/safe-path — parseAllowedDirs', () => {
  it('returns no roots when unset or empty', () => {
    expect(parseAllowedDirs(undefined).dirs).toEqual([]);
    expect(parseAllowedDirs('').dirs).toEqual([]);
    expect(parseAllowedDirs(delimiter + delimiter).dirs).toEqual([]);
  });

  it('splits on the platform delimiter, trims, and deduplicates', () => {
    const raw = [` ${workDir} `, extraDir, workDir, `${workDir}${sep}`].join(delimiter);
    expect(parseAllowedDirs(raw).dirs).toEqual([workDir, extraDir]);
  });

  it('expands a leading ~ against the home directory', () => {
    const { dirs } = parseAllowedDirs(`~/Downloads${delimiter}~`, { home: '/home/agent' });
    expect(dirs).toEqual([join('/home/agent', 'Downloads'), '/home/agent']);
  });

  it('drops non-absolute entries with a warning', () => {
    const { dirs, warnings } = parseAllowedDirs(`relative/dir${delimiter}${extraDir}`);
    expect(dirs).toEqual([extraDir]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('relative/dir');
    expect(warnings[0]).toContain(ALLOWED_DIRS_ENV);
  });
});
