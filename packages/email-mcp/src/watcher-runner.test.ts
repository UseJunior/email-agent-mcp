import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { GraphEmailProvider, type GraphApiClient } from '@usejunior/provider-microsoft';
import type { EmailMessage } from '@usejunior/email-core';
import { MailboxRunner, WatchShutdown, type MailboxRunnerOptions, type MailboxRunState, type WatchSource } from './watcher-runner.js';
import { resetProcessed, loadDeltaState, saveDeltaState, getDeltaStatePath } from './watcher.js';

const start = '2026-01-01T00:00:00.000Z';
const end = '2026-01-01T00:01:00.000Z';
const message = (id = 'same'): EmailMessage => ({
  id, subject: 'Synthetic', from: { email: 'sender@example.test' }, to: [],
  receivedAt: start, isRead: false, hasAttachments: false,
});
function barrier<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await realDelay(5);
  }
  throw new Error('Runner did not reach expected barrier');
}
function harness(overrides: Partial<MailboxRunnerOptions> = {}) {
  const lost = new AbortController();
  const release = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const getNewMessages = vi.fn(async () => [message()]);
  const wake = vi.fn(async () => ({ success: true }));
  const save = vi.fn(async () => {});
  const states: MailboxRunState[] = [];
  const setup = vi.fn(async (): Promise<WatchSource> => ({ getNewMessages, close }));
  const options: MailboxRunnerOptions = {
    provider: 'microsoft', mailbox: 'box', receivingEmail: 'box@example.test', intervalMs: 1000,
    acquire: async () => ({ signal: lost.signal, assertHeld: () => lost.signal.throwIfAborted(), release }),
    setup, load: async () => ({ deltaLink: '', lastUpdated: start }), save, wake,
    allowed: () => true, now: () => end, onState: state => states.push(state), ...overrides,
  };
  const runner = new MailboxRunner(options);
  active.push(runner);
  return { runner, options, lost, release, close, setup, getNewMessages, wake, save, states };
}
let active: MailboxRunner[] = [];
let directory: string;
beforeEach(async () => {
  resetProcessed();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  directory = await mkdtemp(join(tmpdir(), 'watch-runner-'));
});
afterEach(async () => {
  for (const runner of active) runner.abort();
  await Promise.all(active.map(runner => runner.start()));
  active = [];
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe('email-watcher/Complete polling windows', () => {
  it('Scenario: Every page in a bounded window', async () => {
    const get = vi.fn().mockResolvedValueOnce({
      value: Array.from({ length: 50 }, (_, i) => ({ id: String(i), receivedDateTime: start })),
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
    }).mockResolvedValueOnce({ value: [{ id: '50', receivedDateTime: end }] });
    const provider = new GraphEmailProvider({ get } as unknown as GraphApiClient);
    const h = harness({ setup: async () => provider });
    void h.runner.start();
    await until(() => h.save.mock.calls.length === 1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(get.mock.calls[0]![0])).toContain(`receivedDateTime ge ${start} and receivedDateTime le ${end}`);
    expect(h.wake).toHaveBeenCalledTimes(51);
    expect(h.save.mock.calls[0]![1]).toMatchObject({ lastUpdated: end });
  });

  it('Scenario: Later page failure retains checkpoint', async () => {
    const get = vi.fn().mockResolvedValueOnce({ value: [{ id: '1', receivedDateTime: start }], '@odata.nextLink': 'next' })
      .mockRejectedValueOnce(new Error('page two failed'))
      .mockResolvedValueOnce({ value: [{ id: '1', receivedDateTime: start }], '@odata.nextLink': 'next' })
      .mockResolvedValueOnce({ value: [{ id: '2', receivedDateTime: end }] });
    const provider = new GraphEmailProvider({ get } as unknown as GraphApiClient);
    const h = harness({ setup: async () => provider });
    void h.runner.start();
    await until(() => h.runner.state.phase === 'backoff');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => h.save.mock.calls.length === 1);
    expect(h.wake).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(get.mock.calls[2]![0])).toContain(`ge ${start}`);
  });

  it('Scenario: Equal timestamps remain eligible', async () => {
    const h = harness({ now: () => start });
    h.getNewMessages.mockResolvedValueOnce([message('first')]).mockResolvedValueOnce([message('first'), message('late-equal')]);
    void h.runner.start();
    await until(() => h.save.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => h.save.mock.calls.length === 2);
    expect(h.getNewMessages.mock.calls[1]).toEqual([start, start, expect.any(AbortSignal)]);
    expect(h.wake).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Wake and checkpoint failures retain the watermark', async () => {
    const h = harness();
    h.wake.mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true });
    h.save.mockRejectedValueOnce(new Error('disk full'));
    void h.runner.start();
    await until(() => h.runner.state.phase === 'backoff');
    expect(h.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => h.save.mock.calls.length === 1);
    expect(h.runner.state).toMatchObject({ phase: 'backoff', checkpoint: start });
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => h.save.mock.calls.length === 2);
    expect(h.getNewMessages.mock.calls.map(call => call[0])).toEqual([start, start, start]);
    expect(h.wake).toHaveBeenCalledTimes(2);
    expect(h.runner.state).toMatchObject({ phase: 'idle', checkpoint: end });
  });

  it('Scenario: Mailbox and provider dedup namespaces', async () => {
    const a = harness();
    const b = harness({ mailbox: 'other' });
    const c = harness({ provider: 'other' });
    for (const h of [a, b, c]) void h.runner.start();
    await until(() => [a, b, c].every(h => h.save.mock.calls.length === 1));
    for (const h of [a, b, c]) expect(h.wake).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Backoff grows and resets after success', async () => {
    const h = harness();
    h.getNewMessages.mockRejectedValueOnce(new Error('auth')).mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([]).mockRejectedValue(new Error('again'));
    void h.runner.start();
    await until(() => h.runner.state.phase === 'backoff');
    expect(h.runner.state).toMatchObject({ delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.runner.state).toMatchObject({ phase: 'backoff', delayMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.runner.state).toMatchObject({ phase: 'idle' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.runner.state).toMatchObject({ phase: 'backoff', delayMs: 1000 });
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(300_000);
    expect(h.runner.state).toMatchObject({ phase: 'backoff', delayMs: 300_000 });
  });
});

describe('email-watcher/Checkpoint recovery', () => {
  function diskOptions(key: string): Partial<MailboxRunnerOptions> {
    return { mailbox: key, load: loadDeltaState, save: saveDeltaState };
  }
  const keys: string[] = [];
  afterEach(async () => {
    for (const key of keys.splice(0)) await rm(getDeltaStatePath(key), { force: true });
  });
  function key() { const key = `runner-${directory.split('/').pop()}`; keys.push(key); return key; }

  it('Scenario: Runner bootstraps now and restarts from committed disk', async () => {
    const id = key();
    const a = harness(diskOptions(id));
    a.getNewMessages.mockResolvedValue([]);
    void a.runner.start();
    await until(() => a.runner.state.phase === 'idle' && a.getNewMessages.mock.calls.length === 1);
    a.runner.requestStop(); await a.runner.start();
    expect(a.getNewMessages.mock.calls[0]![0]).toBe(end);
    const record = JSON.parse(await readFile(getDeltaStatePath(id), 'utf8'));
    expect(record).toEqual({ version: 1, kind: 'timestamp', lastUpdated: end });
    expect((await stat(getDeltaStatePath(id))).mode & 0o777).toBe(0o600);
    resetProcessed();
    const b = harness(diskOptions(id));
    b.getNewMessages.mockResolvedValue([{ ...message(), receivedAt: end }]);
    void b.runner.start();
    await until(() => b.wake.mock.calls.length === 1);
    expect(b.getNewMessages.mock.calls[0]![0]).toBe(end);
  });

  it('Scenario: Legacy checkpoint migrates through the runner', async () => {
    const id = key();
    await mkdir(dirname(getDeltaStatePath(id)), { recursive: true });
    await writeFile(getDeltaStatePath(id), JSON.stringify({ deltaLink: 'old', lastUpdated: start }));
    const h = harness(diskOptions(id));
    void h.runner.start();
    await until(() => h.runner.state.phase === 'idle' && h.getNewMessages.mock.calls.length === 1);
    expect(h.getNewMessages.mock.calls[0]![0]).toBe(start);
    expect(JSON.parse(await readFile(getDeltaStatePath(id), 'utf8'))).toEqual({ version: 1, kind: 'timestamp', lastUpdated: end });
  });

  it('Scenario: Malformed existing state stops the mailbox', async () => {
    const id = key();
    await mkdir(dirname(getDeltaStatePath(id)), { recursive: true });
    for (const content of ['{', '{}', '{"deltaLink":"","lastUpdated":"yesterday"}',
      '{"version":2,"kind":"timestamp","lastUpdated":"2026-01-01T00:00:00Z"}',
      '{"deltaLink":"","lastUpdated":"2026-02-30T00:00:00Z"}']) {
      await writeFile(getDeltaStatePath(id), content);
      const h = harness(diskOptions(id));
      expect(await h.runner.start()).toMatchObject({ kind: 'failed' });
      expect(h.setup).not.toHaveBeenCalled();
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(await readFile(getDeltaStatePath(id), 'utf8')).toBe(content);
    }
  });

  it('Scenario: Atomic write failure retains disk and cleans temporary files', async () => {
    const id = key();
    await saveDeltaState(id, { deltaLink: '', lastUpdated: start });
    let checks = 0;
    const h = harness({ ...diskOptions(id), save: (key, state, signal) =>
      saveDeltaState(key, state, signal, () => { if (++checks === 3) throw new Error('ownership lost before rename'); }) });
    void h.runner.start();
    await until(() => h.runner.state.phase === 'backoff');
    expect((await loadDeltaState(id))!.lastUpdated).toBe(start);
    expect((await readdir(dirname(getDeltaStatePath(id)))).filter(name => name.startsWith(id) && name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('email-watcher/Drain ownership', () => {
  it('Scenario: No overlapping polls', async () => {
    const gate = barrier<EmailMessage[]>();
    const h = harness(); h.getNewMessages.mockReturnValueOnce(gate.promise);
    void h.runner.start();
    await until(() => h.getNewMessages.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.getNewMessages).toHaveBeenCalledTimes(1);
    gate.resolve([]);
    await until(() => h.save.mock.calls.length === 1);
  });

  it('Scenario: Shutdown during setup retains ownership until setup settles', async () => {
    const gate = barrier<WatchSource>();
    const h = harness({ setup: () => gate.promise });
    void h.runner.start();
    await until(() => h.runner.state.phase === 'bootstrapping');
    // Reach setup past asynchronous acquire/load.
    await new Promise<void>(resolve => setImmediate(resolve));
    h.runner.requestStop();
    expect(h.release).not.toHaveBeenCalled();
    gate.resolve({ getNewMessages: h.getNewMessages, close: h.close });
    await h.runner.start();
    expect(h.getNewMessages).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Failed setup releases its lease', async () => {
    const h = harness({ setup: async () => { throw new Error('auth unavailable'); } });
    expect(await h.runner.start()).toMatchObject({ kind: 'failed' });
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('stops during lease acquisition and releases the late handle without setup', async () => {
    const acquired = barrier<Awaited<ReturnType<MailboxRunnerOptions['acquire']>>>();
    const h = harness({ acquire: () => acquired.promise });
    void h.runner.start(); h.runner.requestStop();
    acquired.resolve({ signal: h.lost.signal, assertHeld: () => {}, release: h.release });
    await h.runner.start();
    expect(h.setup).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it.each(['setup', 'wake', 'checkpoint'] as const)('cancels %s at the deadline and awaits cleanup', async phase => {
    const cleanup = barrier<void>();
    let entered = false;
    let aborted = false;
    const cancellable = async (signal: AbortSignal) => {
      entered = true;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      await cleanup.promise;
      signal.throwIfAborted();
    };
    const h = harness();
    if (phase === 'setup') h.setup.mockImplementationOnce(async signal => {
      await cancellable(signal); return { getNewMessages: h.getNewMessages, close: h.close };
    });
    if (phase === 'wake') h.wake.mockImplementationOnce(async (_payload, signal) => {
      await cancellable(signal); return { success: true };
    });
    if (phase === 'checkpoint') h.save.mockImplementationOnce(async (_key, _state, signal) => { await cancellable(signal!); });
    const shutdown = new WatchShutdown(vi.fn()); shutdown.add(h.runner);
    void h.runner.start(); await until(() => entered);
    shutdown.signal(); await vi.advanceTimersByTimeAsync(15_000);
    expect(aborted).toBe(true); expect(h.release).not.toHaveBeenCalled();
    cleanup.resolve(); await h.runner.start();
    expect(h.release).toHaveBeenCalledTimes(1);
    if (phase !== 'checkpoint') expect(h.save).not.toHaveBeenCalled();
    shutdown.dispose();
  });

  it.each(['poll', 'wake', 'checkpoint'] as const)('drains during %s before releasing ownership', async phase => {
    const gate = barrier<void>();
    const h = harness();
    let entered = false;
    if (phase === 'poll') h.getNewMessages.mockImplementationOnce(async () => { entered = true; await gate.promise; return [message()]; });
    if (phase === 'wake') h.wake.mockImplementationOnce(async () => { entered = true; await gate.promise; return { success: true }; });
    if (phase === 'checkpoint') h.save.mockImplementationOnce(async () => { entered = true; await gate.promise; });
    void h.runner.start();
    await until(() => entered);
    const shutdown = new WatchShutdown(vi.fn()); shutdown.add(h.runner); shutdown.signal();
    expect(h.runner.state.phase).toBe('stopping');
    expect(h.release).not.toHaveBeenCalled();
    gate.resolve(); await h.runner.start();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.getNewMessages).toHaveBeenCalledTimes(1);
    shutdown.dispose();
  });

  it('Scenario: Drain deadline aborts work before lease release', async () => {
    const cleanup = barrier<void>();
    let aborted = false;
    const h = harness();
    h.getNewMessages.mockImplementationOnce(async (_since, _end, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      await cleanup.promise;
      signal.throwIfAborted(); return [];
    });
    const shutdown = new WatchShutdown(vi.fn()); shutdown.add(h.runner);
    void h.runner.start(); await until(() => h.getNewMessages.mock.calls.length === 1);
    shutdown.signal(); await vi.advanceTimersByTimeAsync(14_999);
    expect(aborted).toBe(false); expect(h.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true); expect(h.release).not.toHaveBeenCalled();
    cleanup.resolve(); await h.runner.start();
    expect(h.release).toHaveBeenCalledTimes(1); expect(h.save).not.toHaveBeenCalled();
    shutdown.dispose();
  });

  it('Scenario: Second shutdown signal exits immediately', () => {
    const exit = vi.fn(); const shutdown = new WatchShutdown(exit);
    shutdown.signal(); expect(exit).not.toHaveBeenCalled();
    shutdown.signal(); expect(exit).toHaveBeenCalledWith(0); shutdown.dispose();
  });

  it('Scenario: Lease loss cancels work and prevents wakes and checkpointing', async () => {
    const gate = barrier<EmailMessage[]>();
    const h = harness(); h.getNewMessages.mockReturnValueOnce(gate.promise);
    void h.runner.start(); await until(() => h.getNewMessages.mock.calls.length === 1);
    h.lost.abort(new Error('compromised'));
    expect(h.getNewMessages.mock.calls[0]![2].aborted).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    gate.resolve([message()]);
    expect(await h.runner.start()).toMatchObject({ kind: 'failed' });
    expect(h.wake).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
