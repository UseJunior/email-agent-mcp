import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBodyFile } from './body-loader.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `body-loader-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

describe('content/Body Loader', () => {
  it('reads markdown file content', async () => {
    await writeFile(join(testDir, 'draft.md'), '# Hello\n\nThis is the body.');
    const result = await resolveBodyFile('draft.md', testDir);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('# Hello');
  });

  it('rejects path traversal', async () => {
    const result = await resolveBodyFile('../../../etc/passwd', testDir);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('PATH_TRAVERSAL');
  });

  it('rejects binary files', async () => {
    await writeFile(join(testDir, 'fake.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    const result = await resolveBodyFile('fake.md', testDir);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('BINARY_FILE');
  });

  it('rejects symlink escape', async () => {
    const outsideFile = join(tmpdir(), `outside-${Date.now()}.txt`);
    await writeFile(outsideFile, 'secret data');
    const linkPath = join(testDir, 'escape.md');
    try {
      await symlink(outsideFile, linkPath);
    } catch {
      return; // symlinks may not be supported
    }

    const result = await resolveBodyFile('escape.md', testDir);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('SYMLINK_ESCAPE');

    await rm(outsideFile, { force: true });
  });

  it('returns FILE_NOT_FOUND for missing file', async () => {
    const result = await resolveBodyFile('nonexistent.md', testDir);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('FILE_NOT_FOUND');
  });

  it('parses frontmatter from .md files', async () => {
    await writeFile(join(testDir, 'draft.md'), `---
to: alice@example.com
subject: Hello
---
Body content.`);

    const result = await resolveBodyFile('draft.md', testDir);
    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter!.to).toBe('alice@example.com');
    expect(result.frontmatter!.subject).toBe('Hello');
    expect(result.content).toBe('Body content.');
  });

  it('does not parse frontmatter from non-.md files', async () => {
    await writeFile(join(testDir, 'draft.html'), `---
to: alice@example.com
---
<p>Body</p>`);

    const result = await resolveBodyFile('draft.html', testDir);
    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toBeUndefined();
    expect(result.content).toContain('---');
  });

  it('returns no frontmatter for .md without frontmatter', async () => {
    await writeFile(join(testDir, 'plain.md'), '# Just content\n\nNo frontmatter here.');
    const result = await resolveBodyFile('plain.md', testDir);
    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toBeUndefined();
    expect(result.content).toContain('# Just content');
  });
});
