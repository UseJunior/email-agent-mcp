import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { watch } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WatchedAllowlist } from './watched-allowlist.js';
import type { AllowlistPolicy } from './allowlist-policy.js';
import { isAllowedSender } from './receive-allowlist.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const valid = (entry: string): AllowlistPolicy => ({ status: 'valid', config: { entries: [entry] } });

describe('email-security/Allowlist lifecycle', () => {
  let dir: string;
  let path: string;
  let watcher: WatchedAllowlist;
  let change: (event: string, name: string | null) => void;
  let error: (err: Error) => void;
  let close: ReturnType<typeof vi.fn>;
  let factory: typeof watch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'allowlist-lifecycle-'));
    path = join(dir, 'policy.json');
    close = vi.fn();
    factory = vi.fn((_dir, listener) => {
      change = listener as typeof change;
      return {
        on: (_event: string, handler: typeof error) => { error = handler; },
        unref: vi.fn(), close,
      } as never;
    }) as unknown as typeof watch;
  });
  afterEach(async () => {
    watcher?.close();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('Scenario: Stale reload completion', async () => {
    const first = deferred<AllowlistPolicy>();
    const second = deferred<AllowlistPolicy>();
    const loader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    expect(watcher.lifecycle).toBe('unstarted');
    expect(isAllowedSender('sender@example.com', watcher.policy)).toBe(false);
    const startup = watcher.start();
    expect(watcher.start()).toBe(startup);
    expect(watcher.lifecycle).toBe('starting');
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    change('rename', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    // The new read cannot run or publish ahead of the old one.
    expect(loader).toHaveBeenCalledTimes(1);
    first.resolve(valid('old@example.com'));
    await startup;
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(watcher.config?.entries).toEqual(['old@example.com']);
    second.resolve(valid('new@example.com'));
    await vi.waitFor(() => expect(watcher.config?.entries).toEqual(['new@example.com']));
    expect(watcher.lifecycle).toBe('active');
    await watcher.start();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Close during startup read prevents late publication and releases watch once', async () => {
    const read = deferred<AllowlistPolicy>();
    const loader = vi.fn(() => read.promise);
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    const startup = watcher.start();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    watcher.close();
    watcher.close();
    read.resolve(valid('*'));
    await startup;
    await watcher.start();
    expect(watcher.lifecycle).toBe('closed');
    expect(watcher.policy.status).toBe('invalid');
    expect(close).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('Scenario: Close before directory creation completes never arms a watcher', async () => {
    const loader = vi.fn(async () => valid('*'));
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    const startup = watcher.start();
    watcher.close();
    await startup;
    expect(factory).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
    expect(watcher.lifecycle).toBe('closed');
  });

  it('Scenario: Close during reload prevents late publish and queued reads', async () => {
    const pending = deferred<AllowlistPolicy>();
    const loader = vi.fn().mockResolvedValueOnce(valid('good@example.com')).mockReturnValue(pending.promise);
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    await watcher.start();
    vi.useFakeTimers();
    change('change', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(loader).toHaveBeenCalledTimes(2);
    change('rename', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    watcher.close();
    pending.resolve(valid('*'));
    await vi.advanceTimersByTimeAsync(5);
    change('rename', null);
    await vi.advanceTimersByTimeAsync(5);
    expect(watcher.config?.entries).toEqual(['good@example.com']);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('Scenario: Invalid startup stays blocked until a valid reload', async () => {
    const loader = vi.fn(async (): Promise<AllowlistPolicy> => ({ status: 'invalid', reason: 'Malformed JSON' }));
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    await watcher.start();
    expect(watcher.policy.status).toBe('invalid');
    expect(isAllowedSender('sender@example.com', watcher.policy)).toBe(false);
    vi.useFakeTimers();
    change('rename', 'unrelated.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(loader).toHaveBeenCalledOnce();
    change('change', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(isAllowedSender('sender@example.com', watcher.policy)).toBe(false);
    loader.mockResolvedValue(valid('*'));
    change('change', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(isAllowedSender('sender@example.com', watcher.policy)).toBe(true);
  });

  it('Scenario: Invalid reload retains last good, deletion resets, recreation recovers', async () => {
    const loader = vi.fn(async (): Promise<AllowlistPolicy> => valid('good@example.com'));
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    await watcher.start();
    vi.useFakeTimers();
    loader.mockResolvedValue({ status: 'invalid', reason: 'Malformed JSON' });
    change('change', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(watcher.config?.entries).toEqual(['good@example.com']);
    loader.mockResolvedValue({ status: 'absent' });
    change('rename', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(watcher.policy).toEqual({ status: 'absent' });
    loader.mockResolvedValue({ status: 'invalid', reason: 'Malformed JSON' });
    change('rename', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(watcher.policy.status).toBe('absent');
    loader.mockResolvedValue(valid('recreated@example.com'));
    change('rename', null);
    await vi.advanceTimersByTimeAsync(5);
    expect(watcher.config?.entries).toEqual(['recreated@example.com']);
  });

  it('Scenario: Watcher failure degrades without discarding policy or scheduling more reads', async () => {
    const loader = vi.fn(async () => valid('good@example.com'));
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    await watcher.start();
    vi.useFakeTimers();
    change('rename', 'policy.json');
    error(new Error('watch failed'));
    change('rename', 'policy.json');
    await vi.advanceTimersByTimeAsync(10);
    expect(watcher.lifecycle).toBe('degraded');
    expect(watcher.config?.entries).toEqual(['good@example.com']);
    expect(loader).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('Scenario: Legacy undefined loader still distinguishes invalid startup from absence', async () => {
    await writeFile(path, '{ invalid');
    watcher = new WatchedAllowlist(path, async () => undefined, 5, factory);
    await watcher.start();
    expect(watcher.policy.status).toBe('invalid');
    expect(isAllowedSender('sender@example.com', watcher.policy)).toBe(false);
  });

  it('Scenario: Legacy config loader retains its signature and unexpected reload failure keeps policy', async () => {
    const loader = vi.fn(async () => ({ entries: ['good@example.com'] }));
    watcher = new WatchedAllowlist(path, loader, 5, factory);
    await watcher.start();
    expect(watcher.config).toEqual({ entries: ['good@example.com'] });
    vi.useFakeTimers();
    loader.mockRejectedValue(new Error('Unexpected read failure'));
    change('change', 'policy.json');
    await vi.advanceTimersByTimeAsync(5);
    expect(watcher.config).toEqual({ entries: ['good@example.com'] });
  });
});
