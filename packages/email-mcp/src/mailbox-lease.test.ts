import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import ts from 'typescript';
import lockfile from 'proper-lockfile';
import { MailboxLease } from './mailbox-lease.js';

const directories: string[] = [];
const leases: MailboxLease[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'email-lease-test-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('email-watcher/MailboxLease', () => {
  it('keeps simultaneous mailboxes independent in either release order', async () => {
    const dir = await fixture();
    for (const order of [[0, 1], [1, 0]]) {
      const owned = await Promise.all(['a', 'b'].map(key => MailboxLease.acquire(dir, key)));
      expect(owned.every(lease => lease?.held)).toBe(true);
      leases.push(...owned as MailboxLease[]);
      for (const index of order) await owned[index]!.release();
      for (const key of ['a', 'b']) await expect(stat(join(dir, `${key}.watcher.lock.lease`))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('continues the second mailbox heartbeat after the first is released', async () => {
    const dir = await fixture();
    const a = (await MailboxLease.acquire(dir, 'a'))!;
    const b = (await MailboxLease.acquire(dir, 'b'))!;
    leases.push(a, b);
    const path = join(dir, 'b.watcher.lock.lease');
    const before = (await stat(path)).mtimeMs;
    await a.release();
    await vi.waitFor(async () => expect((await stat(path)).mtimeMs).toBeGreaterThan(before), { timeout: 12_000, interval: 100 });
    b.assertHeld();
    await b.release();
  }, 15_000);

  it('allows wrapper reacquisition after releasing the acquired handle', async () => {
    vi.resetModules();
    vi.stubEnv('EMAIL_AGENT_MCP_HOME', await fixture());
    const { acquireMailboxLease, releaseAllLocks } = await import('./watcher.js');
    try {
      const first = (await acquireMailboxLease('box'))!;
      await first.release();
      const second = (await acquireMailboxLease('box'))!;
      expect(second?.held).toBe(true);
      await first.release();
      expect(await acquireMailboxLease('box')).toBeNull();
    } finally { await releaseAllLocks(); }
  });
  it('refuses live, malformed and indeterminate legacy locks', async () => {
    const dir = await fixture();
    const path = join(dir, 'box.watcher.lock');
    await writeFile(path, JSON.stringify({ pid: process.pid }));
    expect(await MailboxLease.acquire(dir, 'box')).toBeNull();
    await writeFile(path, '{bad');
    expect(await MailboxLease.acquire(dir, 'box')).toBeNull();
    await writeFile(path, JSON.stringify({ pid: -1 }));
    expect(await MailboxLease.acquire(dir, 'box')).toBeNull();
    await writeFile(path, JSON.stringify({ pid: process.pid }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission'), { code: 'EPERM' });
    });
    expect(await MailboxLease.acquire(dir, 'box')).toBeNull();
  });

  it('recovers a stale lease and releases only its acquired handle', async () => {
    const dir = await fixture();
    const path = join(dir, 'box.watcher.lock.lease');
    await mkdir(path);
    const old = new Date(Date.now() - 120_000);
    await utimes(path, old, old);
    const first = await MailboxLease.acquire(dir, 'box');
    expect(first?.held).toBe(true);
    leases.push(first!);
    await first!.release();
    const second = await MailboxLease.acquire(dir, 'box');
    expect(second?.held).toBe(true);
    leases.push(second!);
    await first!.release();
    expect(await MailboxLease.acquire(dir, 'box')).toBeNull();
    expect(second!.held).toBe(true);
  });

  it('aborts immediately on compromise and never releases a successor', async () => {
    const release = vi.fn(async () => {});
    let compromise!: (error: Error) => void;
    vi.spyOn(lockfile, 'lock').mockImplementation(async (_path, options) => {
      expect(options).toMatchObject({ stale: 60_000, update: 10_000, retries: 0 });
      compromise = options!.onCompromised!;
      return release;
    });
    const lease = (await MailboxLease.acquire(await fixture(), 'box'))!;
    leases.push(lease);
    compromise(new Error('lease lost'));
    expect(lease.signal.aborted).toBe(true);
    expect(() => lease.assertHeld()).toThrow('no longer held');
    await lease.release();
    expect(release).not.toHaveBeenCalled();
  });

  it('Scenario: Concurrent watcher acquisition', async () => {
    const dir = await fixture();
    const source = await readFile(new URL('./mailbox-lease.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const script = `${compiled}
      process.send('ready');
      process.once('message', async () => {
        const lease = await MailboxLease.acquire(${JSON.stringify(dir)}, 'box');
        process.send(lease ? 'held' : 'blocked');
        process.once('message', async () => { await lease?.release(); process.disconnect(); });
      });`;
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }));
    try {
      await Promise.all(children.map(child => once(child, 'message')));
      const results = children.map(child => once(child, 'message'));
      children.forEach(child => child.send('go'));
      expect((await Promise.all(results)).map(([result]) => result).sort()).toEqual(['blocked', 'held']);
      const exits = children.map(child => once(child, 'exit'));
      children.forEach(child => child.send('release'));
      expect((await Promise.all(exits)).map(([code]) => code)).toEqual([0, 0]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  }, 15_000);
});
