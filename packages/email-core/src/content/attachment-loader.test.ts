import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveAttachments,
  ATTACHMENT_DIR_ENV,
  ATTACHMENT_MAX_SIZE,
} from './attachment-loader.js';

let baseDir: string;
const savedEnv = process.env[ATTACHMENT_DIR_ENV];

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'attachment-loader-test-'));
  process.env[ATTACHMENT_DIR_ENV] = baseDir;
});

afterEach(async () => {
  if (savedEnv === undefined) {
    delete process.env[ATTACHMENT_DIR_ENV];
  } else {
    process.env[ATTACHMENT_DIR_ENV] = savedEnv;
  }
  await rm(baseDir, { recursive: true, force: true });
});

describe('content/attachment-loader — happy path', () => {
  it('loads a single small attachment', async () => {
    const path = join(baseDir, 'hello.txt');
    await writeFile(path, 'hello world');

    const res = await resolveAttachments(['hello.txt']);
    expect(res.error).toBeUndefined();
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments![0]!.filename).toBe('hello.txt');
    expect(res.attachments![0]!.content.toString('utf-8')).toBe('hello world');
    expect(res.attachments![0]!.mimeType).toBe('text/plain');
  });

  it('loads a zero-byte attachment', async () => {
    const path = join(baseDir, 'empty.pdf');
    await writeFile(path, '');

    const res = await resolveAttachments(['empty.pdf']);
    expect(res.error).toBeUndefined();
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments![0]!.content.length).toBe(0);
    expect(res.attachments![0]!.mimeType).toBe('application/pdf');
  });

  it('loads an attachment exactly at the 3 MiB size cap', async () => {
    const path = join(baseDir, 'big.bin');
    await writeFile(path, Buffer.alloc(ATTACHMENT_MAX_SIZE, 0x41));

    const res = await resolveAttachments(['big.bin']);
    expect(res.error).toBeUndefined();
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments![0]!.content.length).toBe(ATTACHMENT_MAX_SIZE);
  });

  it('rejects an attachment one byte over the cap', async () => {
    const path = join(baseDir, 'toobig.bin');
    await writeFile(path, Buffer.alloc(ATTACHMENT_MAX_SIZE + 1, 0x41));

    const res = await resolveAttachments(['toobig.bin']);
    expect(res.attachments).toBeUndefined();
    expect(res.error?.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(res.error?.message).toContain(String(ATTACHMENT_MAX_SIZE + 1));
  });

  it('detects mime types for common extensions', async () => {
    await writeFile(join(baseDir, 'doc.pdf'), 'x');
    await writeFile(join(baseDir, 'sheet.xlsx'), 'x');
    await writeFile(join(baseDir, 'img.png'), 'x');
    await writeFile(join(baseDir, 'unknown.xyz123'), 'x');

    const res = await resolveAttachments(['doc.pdf', 'sheet.xlsx', 'img.png', 'unknown.xyz123']);
    expect(res.attachments).toHaveLength(4);
    expect(res.attachments![0]!.mimeType).toBe('application/pdf');
    expect(res.attachments![1]!.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.attachments![2]!.mimeType).toBe('image/png');
    expect(res.attachments![3]!.mimeType).toBe('application/octet-stream');
  });

  it('returns [] when paths is empty (does not require env var)', async () => {
    delete process.env[ATTACHMENT_DIR_ENV];

    const res = await resolveAttachments([]);
    expect(res.error).toBeUndefined();
    expect(res.attachments).toEqual([]);
  });
});

describe('content/attachment-loader — env var validation', () => {
  it('rejects when env var is unset', async () => {
    delete process.env[ATTACHMENT_DIR_ENV];

    const res = await resolveAttachments(['x.txt']);
    expect(res.error?.code).toBe('ATTACHMENT_DIR_NOT_CONFIGURED');
  });

  it('rejects when env var is relative', async () => {
    process.env[ATTACHMENT_DIR_ENV] = 'relative/path';

    const res = await resolveAttachments(['x.txt']);
    expect(res.error?.code).toBe('ATTACHMENT_DIR_NOT_ABSOLUTE');
  });

  it('rejects when env var points to a nonexistent directory', async () => {
    process.env[ATTACHMENT_DIR_ENV] = '/tmp/definitely-does-not-exist-123456789';

    const res = await resolveAttachments(['x.txt']);
    expect(res.error?.code).toBe('ATTACHMENT_DIR_NOT_FOUND');
  });

  it('rejects when env var points to a file instead of a directory', async () => {
    const filePath = join(baseDir, 'not-a-dir');
    await writeFile(filePath, 'x');
    process.env[ATTACHMENT_DIR_ENV] = filePath;

    const res = await resolveAttachments(['x.txt']);
    expect(res.error?.code).toBe('ATTACHMENT_DIR_NOT_FOUND');
  });
});

describe('content/attachment-loader — path traversal', () => {
  it('rejects ../../../etc/passwd style traversal', async () => {
    const res = await resolveAttachments(['../../../etc/passwd']);
    // Realpath may succeed on /etc/passwd, but isPathInsideDir should reject
    expect(res.error?.code).toMatch(/^ATTACHMENT_(NOT_ALLOWED|NOT_FOUND)$/);
  });

  it('rejects sibling-prefix attack (baseDir is /tmp/allowed, candidate in /tmp/allowed-evil)', async () => {
    // Use OS tmp dir to create baseDir and a sibling "<baseDir>-evil"
    const evilDir = `${baseDir}-evil`;
    await mkdir(evilDir, { recursive: true });
    const evilFile = join(evilDir, 'stolen.txt');
    await writeFile(evilFile, 'secret');

    try {
      const res = await resolveAttachments([evilFile]);
      expect(res.attachments).toBeUndefined();
      expect(res.error?.code).toBe('ATTACHMENT_NOT_ALLOWED');
    } finally {
      await rm(evilDir, { recursive: true, force: true });
    }
  });

  it('rejects symlink escape (symlink inside baseDir points outside)', async () => {
    // Create the target file outside baseDir, and a symlink to it inside
    const outsideDir = `${baseDir}-outside`;
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'secret.txt');
    await writeFile(outsideFile, 'secret');

    const link = join(baseDir, 'link.txt');
    try {
      await symlink(outsideFile, link);
      const res = await resolveAttachments(['link.txt']);
      expect(res.error?.code).toBe('ATTACHMENT_NOT_ALLOWED');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows symlink inside baseDir that points to another file inside baseDir', async () => {
    await writeFile(join(baseDir, 'target.txt'), 'inside');
    await symlink(join(baseDir, 'target.txt'), join(baseDir, 'alias.txt'));

    const res = await resolveAttachments(['alias.txt']);
    expect(res.error).toBeUndefined();
    expect(res.attachments).toHaveLength(1);
  });

  it('rejects a path that does not exist', async () => {
    const res = await resolveAttachments(['ghost.txt']);
    expect(res.error?.code).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('content/attachment-loader — dedupe and disambiguation', () => {
  it('dedupes identical paths', async () => {
    await writeFile(join(baseDir, 'one.txt'), 'hello');

    const res = await resolveAttachments(['one.txt', 'one.txt']);
    expect(res.attachments).toHaveLength(1);
  });

  it('dedupes absolute path and relative path pointing to the same file', async () => {
    await writeFile(join(baseDir, 'one.txt'), 'hello');

    const res = await resolveAttachments(['one.txt', join(baseDir, 'one.txt')]);
    expect(res.attachments).toHaveLength(1);
  });

  it('dedupes symlink alias pointing to the same realpath', async () => {
    await writeFile(join(baseDir, 'target.txt'), 'hello');
    await symlink(join(baseDir, 'target.txt'), join(baseDir, 'alias.txt'));

    const res = await resolveAttachments(['target.txt', 'alias.txt']);
    expect(res.attachments).toHaveLength(1);
  });

  it('disambiguates two different files that share a basename', async () => {
    await mkdir(join(baseDir, 'sub1'));
    await mkdir(join(baseDir, 'sub2'));
    await writeFile(join(baseDir, 'sub1', 'report.pdf'), 'first');
    await writeFile(join(baseDir, 'sub2', 'report.pdf'), 'second');

    const res = await resolveAttachments(['sub1/report.pdf', 'sub2/report.pdf']);
    expect(res.attachments).toHaveLength(2);
    expect(res.attachments![0]!.filename).toBe('report.pdf');
    expect(res.attachments![1]!.filename).toBe('report (2).pdf');
    expect(res.attachments![0]!.content.toString('utf-8')).toBe('first');
    expect(res.attachments![1]!.content.toString('utf-8')).toBe('second');
  });

  it('disambiguates three same-named files with (2), (3) suffixes', async () => {
    await mkdir(join(baseDir, 'a'));
    await mkdir(join(baseDir, 'b'));
    await mkdir(join(baseDir, 'c'));
    await writeFile(join(baseDir, 'a', 'x.txt'), '1');
    await writeFile(join(baseDir, 'b', 'x.txt'), '2');
    await writeFile(join(baseDir, 'c', 'x.txt'), '3');

    const res = await resolveAttachments(['a/x.txt', 'b/x.txt', 'c/x.txt']);
    expect(res.attachments).toHaveLength(3);
    expect(res.attachments!.map(a => a.filename)).toEqual(['x.txt', 'x (2).txt', 'x (3).txt']);
  });
});
