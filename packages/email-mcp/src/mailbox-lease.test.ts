import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('email-watcher/MailboxLease', () => {
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
