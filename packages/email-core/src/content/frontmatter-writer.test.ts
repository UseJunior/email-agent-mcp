import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchFrontmatter } from './frontmatter-writer.js';
import { parseFrontmatter } from './frontmatter.js';

let workDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'fm-writer-test-'));
  // Silence stderr writes inside tests so the test reporter stays clean.
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stderrSpy.mockRestore();
  await rm(workDir, { recursive: true, force: true });
});

describe('content/frontmatter-writer — no existing frontmatter', () => {
  it('prepends a new frontmatter block when file has none', async () => {
    const filePath = join(workDir, 'plain.md');
    await writeFile(filePath, 'Just a body\nSecond line\n');

    const res = await patchFrontmatter(filePath, { draft_id: 'abc123' });
    expect(res.ok).toBe(true);

    const updated = await readFile(filePath, 'utf-8');
    expect(updated.startsWith('---\n')).toBe(true);
    expect(updated).toContain('draft_id: abc123');
    expect(updated).toContain('Just a body\nSecond line\n');
  });
});

describe('content/frontmatter-writer — patch existing frontmatter', () => {
  it('appends a new key when not present', async () => {
    const filePath = join(workDir, 'reply.md');
    await writeFile(filePath, `---
to: alice@example.com
subject: Hello
---
Body content`);

    const res = await patchFrontmatter(filePath, {
      draft_reply_id: 'xyz789',
      draft_reply_link: 'https://outlook.office.com/mail/deeplink/compose?ItemID=xyz789',
    });
    expect(res.ok).toBe(true);

    const updated = await readFile(filePath, 'utf-8');
    const parsed = parseFrontmatter(updated);
    expect(parsed.body).toBe('Body content');
    // draft_reply_id is not a known frontmatter key so it'll be in the raw text but not in parsed.frontmatter
    expect(updated).toContain('draft_reply_id: xyz789');
    expect(updated).toContain('draft_reply_link: https://outlook.office.com/mail/deeplink/compose?ItemID=xyz789');
    // Existing keys preserved
    expect(parsed.frontmatter?.to).toBe('alice@example.com');
    expect(parsed.frontmatter?.subject).toBe('Hello');
  });

  it('replaces an existing key in place', async () => {
    const filePath = join(workDir, 'update.md');
    await writeFile(filePath, `---
to: alice@example.com
draft_id: old-id
---
Body`);

    const res = await patchFrontmatter(filePath, { draft_id: 'new-id' });
    expect(res.ok).toBe(true);

    const updated = await readFile(filePath, 'utf-8');
    expect(updated).toContain('draft_id: new-id');
    expect(updated).not.toContain('old-id');
  });

  it('preserves body bytes exactly (including trailing newlines)', async () => {
    const filePath = join(workDir, 'preserve.md');
    const body = '# Heading\n\n- bullet\n- another\n\n  indented code\n\nfinal line\n';
    await writeFile(filePath, `---
subject: Test
---
${body}`);

    await patchFrontmatter(filePath, { draft_id: 'xxx' });

    const updated = await readFile(filePath, 'utf-8');
    expect(updated.endsWith(body)).toBe(true);
  });

  it('only patches the first occurrence of a duplicate key', async () => {
    const filePath = join(workDir, 'dup.md');
    await writeFile(filePath, `---
draft_id: first
other: value
draft_id: second
---
Body`);

    const res = await patchFrontmatter(filePath, { draft_id: 'patched' });
    expect(res.ok).toBe(true);

    const updated = await readFile(filePath, 'utf-8');
    expect(updated).toContain('draft_id: patched');
    expect(updated).toContain('draft_id: second');
    expect(updated).not.toContain('draft_id: first');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('duplicate keys'));
  });

  it('refuses to patch when frontmatter contains multiline YAML scalar', async () => {
    const filePath = join(workDir, 'multiline.md');
    const original = `---
subject: |
  line one
  line two
---
Body`;
    await writeFile(filePath, original);

    const res = await patchFrontmatter(filePath, { draft_id: 'abc' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('multiline');

    const unchanged = await readFile(filePath, 'utf-8');
    expect(unchanged).toBe(original);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('multiline scalar'));
  });

  it('refuses to patch when frontmatter block is unclosed', async () => {
    const filePath = join(workDir, 'unclosed.md');
    const original = `---
subject: Test
(no closing marker)
Body`;
    await writeFile(filePath, original);

    const res = await patchFrontmatter(filePath, { draft_id: 'abc' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('unclosed');
  });
});

describe('content/frontmatter-writer — CRLF handling', () => {
  it('preserves CRLF line endings', async () => {
    const filePath = join(workDir, 'crlf.md');
    const crlfContent = '---\r\nsubject: Hi\r\n---\r\nBody\r\nline 2\r\n';
    await writeFile(filePath, crlfContent);

    const res = await patchFrontmatter(filePath, { draft_id: 'abc' });
    expect(res.ok).toBe(true);

    const updated = await readFile(filePath, 'utf-8');
    expect(updated).toContain('\r\n');
    expect(updated).not.toMatch(/[^\r]\n/); // no bare LF
    expect(updated).toContain('subject: Hi');
    expect(updated).toContain('draft_id: abc');
    expect(updated).toContain('Body\r\nline 2\r\n');
  });
});

describe('content/frontmatter-writer — validation', () => {
  it('rejects invalid key names', async () => {
    const filePath = join(workDir, 'ok.md');
    await writeFile(filePath, 'body');

    const res = await patchFrontmatter(filePath, { 'bad key!': 'v' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('invalid key');
  });

  it('rejects values containing newlines', async () => {
    const filePath = join(workDir, 'ok.md');
    await writeFile(filePath, 'body');

    const res = await patchFrontmatter(filePath, { ok: 'line1\nline2' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('single-line');
  });

  it('returns ok: false (no throw) when file is missing', async () => {
    const res = await patchFrontmatter(join(workDir, 'ghost.md'), { x: 'y' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('read failed');
  });

  it('returns ok: false (no throw) when file is read-only', async () => {
    const filePath = join(workDir, 'readonly.md');
    await writeFile(filePath, '---\nsubject: x\n---\nbody');
    await chmod(filePath, 0o444);

    try {
      const res = await patchFrontmatter(filePath, { draft_id: 'abc' });
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('write failed');
    } finally {
      await chmod(filePath, 0o644).catch(() => {});
    }
  });
});
