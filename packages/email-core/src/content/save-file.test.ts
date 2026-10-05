// Sandbox policy coverage for writing downloaded bytes to disk (#169):
// download_attachment `save_to` and download_message share these helpers.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSaveDir, toDiskFilename, writeFileExclusive } from './save-file.js';

let root: string;
let workDir: string;
let extraDir: string;
let outsideDir: string;

async function trySymlink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'save-file-test-')));
  workDir = join(root, 'work');
  extraDir = join(root, 'extra');
  outsideDir = join(root, 'outside');
  await mkdir(workDir);
  await mkdir(extraDir);
  await mkdir(outsideDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('content/save-file — resolveSaveDir', () => {
  it('resolves a relative directory under the safe directory, creating it', async () => {
    const result = await resolveSaveDir('attachments/2026', workDir);
    expect(result.error).toBeUndefined();
    expect(result.resolved).toBe(join(workDir, 'attachments', '2026'));
    expect((await stat(result.resolved!)).isDirectory()).toBe(true);
  });

  it('accepts the safe directory itself', async () => {
    expect((await resolveSaveDir('.', workDir)).resolved).toBe(workDir);
  });

  it('accepts an absolute path inside an allowlisted root', async () => {
    const result = await resolveSaveDir(join(extraDir, 'inbox'), { safeDir: workDir, allowedDirs: [extraDir] });
    expect(result.resolved).toBe(join(extraDir, 'inbox'));
  });

  it('does not search allowlisted roots for a relative path', async () => {
    const result = await resolveSaveDir('inbox', { safeDir: workDir, allowedDirs: [extraDir] });
    expect(result.resolved).toBe(join(workDir, 'inbox'));
  });

  it('rejects .. traversal', async () => {
    const result = await resolveSaveDir('../outside', workDir);
    expect(result.error?.code).toBe('PATH_TRAVERSAL');
  });

  it('rejects an absolute path outside every root and names the env var', async () => {
    const result = await resolveSaveDir(outsideDir, { safeDir: workDir, allowedDirs: [extraDir] });
    expect(result.error?.code).toBe('PATH_TRAVERSAL');
    expect(result.error?.message).toContain('AGENT_EMAIL_ALLOWED_DIRS');
  });

  it('rejects a leading ~ with a pointer to absolute paths', async () => {
    const result = await resolveSaveDir('~/Downloads', workDir);
    expect(result.error?.code).toBe('INVALID_PATH');
    expect(result.error?.message).toMatch(/not expanded/);
  });

  it('rejects a symlinked directory that escapes the sandbox and creates nothing outside', async () => {
    if (!(await trySymlink(outsideDir, join(workDir, 'link')))) return;
    const result = await resolveSaveDir('link/sub', workDir);
    expect(result.error?.code).toBe('SYMLINK_ESCAPE');
    await expect(stat(join(outsideDir, 'sub'))).rejects.toThrow();
  });

  it('rejects a path that names an existing file', async () => {
    await writeFile(join(workDir, 'file.txt'), 'x');
    const result = await resolveSaveDir('file.txt', workDir);
    expect(result.error?.code).toBe('NOT_A_DIRECTORY');
  });
});

describe('content/save-file — writeFileExclusive', () => {
  it('writes the bytes and reports matching size and SHA-256', async () => {
    const bytes = Buffer.from('%PDF-1.4 signed record copy');
    const saved = await writeFileExclusive(workDir, 'record.pdf', bytes);
    const onDisk = await readFile(saved.path);
    expect(onDisk.equals(bytes)).toBe(true);
    expect(saved.size).toBe(onDisk.length);
    expect(saved.sha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
    if (process.platform !== 'win32') {
      expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    }
  });

  it('never overwrites: collisions get deterministic numeric suffixes', async () => {
    await writeFile(join(workDir, 'report.pdf'), 'existing');
    const first = await writeFileExclusive(workDir, 'report.pdf', Buffer.from('a'));
    const second = await writeFileExclusive(workDir, 'report.pdf', Buffer.from('b'));
    expect(first.filename).toBe('report-1.pdf');
    expect(second.filename).toBe('report-2.pdf');
    expect(await readFile(join(workDir, 'report.pdf'), 'utf8')).toBe('existing');
  });

  it('does not follow a symlink planted at the target name', async () => {
    const victim = join(outsideDir, 'victim.txt');
    await writeFile(victim, 'untouched');
    if (!(await trySymlink(victim, join(workDir, 'note.txt')))) return;
    const saved = await writeFileExclusive(workDir, 'note.txt', Buffer.from('payload'));
    expect(saved.filename).toBe('note-1.txt');
    expect(await readFile(victim, 'utf8')).toBe('untouched');
  });
});

describe('content/save-file — toDiskFilename', () => {
  it('strips unsafe characters from the extension and leading dots', () => {
    expect(toDiskFilename('.bashrc', 'attachment')).toBe('bashrc');
    expect(toDiskFilename('a.p$df', 'attachment')).toBe('a.pdf');
  });

  it('falls back when nothing usable remains', () => {
    expect(toDiskFilename('___', 'attachment')).toBe('attachment');
    expect(toDiskFilename('', 'message', '.eml')).toBe('message.eml');
  });

  it('forces an extension when asked', () => {
    expect(toDiskFilename('Signed_Agreement', 'message', '.eml')).toBe('Signed_Agreement.eml');
    expect(toDiskFilename('Agreement_v2.1', 'message', '.eml')).toBe('Agreement_v2.1.eml');
  });

  it('caps very long names', () => {
    expect(toDiskFilename(`${'a'.repeat(500)}.pdf`, 'attachment').length).toBeLessThanOrEqual(154);
  });
});
