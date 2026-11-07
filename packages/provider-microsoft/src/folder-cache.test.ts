import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphEmailProvider, type GraphApiClient } from './email-graph-provider.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function client(get: GraphApiClient['get']) {
  return {
    get,
    post: vi.fn().mockResolvedValue({ id: 'created', displayName: 'Child' }),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const tree = (id: string) => ({ value: [{ id, displayName: 'Target', childFolderCount: 0 }] });
const rule = { displayName: 'File', sequence: 1, conditions: {}, actions: { moveToFolder: 'archive' } };

afterEach(() => vi.restoreAllMocks());

describe('provider-microsoft/Versioned folder caches (#108, approved harden-email-state-machines group 14)', () => {
  it('Scenario: Concurrent folder reads share one complete traversal', async () => {
    const root = deferred<ReturnType<typeof tree>>();
    const child = deferred<ReturnType<typeof tree>>();
    const childStarted = deferred<void>();
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?')) return root.promise;
      childStarted.resolve();
      return child.promise;
    });
    const provider = new GraphEmailProvider(client(get));
    const first = provider.listFolders();
    const second = provider.listFolders();
    root.resolve({ value: [{ id: 'parent', displayName: 'Parent', childFolderCount: 1 }] });
    await childStarted.promise;
    const third = provider.listFolders();
    expect(get).toHaveBeenCalledTimes(2);
    child.resolve(tree('child'));
    const results = await Promise.all([first, second, third]);
    expect(results.map(folders => folders.map(folder => folder.id))).toEqual([
      ['parent', 'child'], ['parent', 'child'], ['parent', 'child'],
    ]);
    results[0]![0]!.displayName = 'Caller edit';
    expect((await provider.listFolders())[0]!.displayName).toBe('Parent');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Concurrent system folder reads share one ID sweep', async () => {
    const archive = deferred<{ id: string }>();
    const started = deferred<void>();
    const get = vi.fn(async (url: string) => {
      if (url.includes('/archive?')) { started.resolve(); return archive.promise; }
      return { id: url.split('?')[0] };
    });
    const provider = new GraphEmailProvider(client(get));
    const first = provider.createInboxRule(rule);
    const second = provider.createInboxRule(rule);
    await started.promise;
    expect(get).toHaveBeenCalledTimes(1);
    archive.resolve({ id: 'archive-id' });
    await Promise.all([first, second]);
    const urls = get.mock.calls.map(([url]) => url);
    expect(new Set(urls).size).toBe(urls.length);
    const count = get.mock.calls.length;
    await provider.createInboxRule(rule);
    expect(get).toHaveBeenCalledTimes(count);
  });

  it('Scenario: Folder mutation supersedes an in-flight traversal', async () => {
    for (const oldFirst of [true, false]) {
      const old = deferred<ReturnType<typeof tree>>();
      const fresh = deferred<ReturnType<typeof tree>>();
      const oldStarted = deferred<void>();
      const freshStarted = deferred<void>();
      const get = vi.fn(() => {
        if (get.mock.calls.length === 1) { oldStarted.resolve(); return old.promise; }
        freshStarted.resolve();
        return fresh.promise;
      });
      const provider = new GraphEmailProvider(client(get));
      const first = provider.listFolders();
      await oldStarted.promise;
      // Well-known parent avoids traversal; successful mutation invalidates both caches.
      await provider.createFolder('Child');
      const later = provider.listFolders();
      await freshStarted.promise;
      if (oldFirst) old.resolve(tree('old'));
      fresh.resolve(tree('fresh'));
      expect((await later)[0]!.id).toBe('fresh');
      if (!oldFirst) old.resolve(tree('old'));
      expect((await first)[0]!.id).toBe('fresh');
      expect((await provider.listFolders())[0]!.id).toBe('fresh');
      expect(get).toHaveBeenCalledTimes(2);
    }
  });

  it('Scenario: Folder mutation supersedes an in-flight system ID sweep', async () => {
    for (const oldFirst of [true, false]) {
      const old = deferred<{ id: string }>();
      const fresh = deferred<{ id: string }>();
      const oldStarted = deferred<void>();
      const freshStarted = deferred<void>();
      let sweeps = 0;
      const get = vi.fn(async (url: string) => {
        if (url.includes('/archive?')) {
          if (++sweeps === 1) { oldStarted.resolve(); return old.promise; }
          freshStarted.resolve();
          return fresh.promise;
        }
        return { id: url.split('?')[0] };
      });
      const mock = client(get);
      const provider = new GraphEmailProvider(mock);
      const first = provider.createInboxRule(rule);
      await oldStarted.promise;
      await provider.createFolder('Child');
      const later = provider.createInboxRule(rule);
      await freshStarted.promise;
      if (oldFirst) old.resolve({ id: 'old' });
      fresh.resolve({ id: 'fresh' });
      await later;
      if (!oldFirst) old.resolve({ id: 'old' });
      await first;
      await provider.createInboxRule(rule);
      expect(sweeps).toBe(2);
      const writes = mock.post.mock.calls.filter(([url]) => url.endsWith('/messageRules'));
      expect(writes).toHaveLength(3);
      for (const [, body] of writes) expect(body.actions.moveToFolder).toBe('fresh');
    }
  });

  it('Scenario: Failed folder loads clear shared state and retry', async () => {
    const failed = deferred<ReturnType<typeof tree>>();
    const started = deferred<void>();
    const get = vi.fn(() => {
      if (get.mock.calls.length === 1) { started.resolve(); return failed.promise; }
      return Promise.resolve(tree('retry'));
    });
    const provider = new GraphEmailProvider(client(get));
    const results = Promise.allSettled([provider.listFolders(), provider.listFolders()]);
    await started.promise;
    failed.reject(new Error('Graph unavailable'));
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(get).toHaveBeenCalledTimes(1);
    expect((await provider.listFolders())[0]!.id).toBe('retry');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Failed system ID loads clear shared state and retry', async () => {
    const failed = deferred<{ id: string }>();
    const started = deferred<void>();
    let fail = true;
    const get = vi.fn(async (url: string) => {
      if (url.includes('/archive?')) {
        if (fail) { started.resolve(); return failed.promise; }
        return { id: 'retry' };
      }
      return { id: url.split('?')[0] };
    });
    const mock = client(get);
    const provider = new GraphEmailProvider(mock);
    const results = Promise.allSettled([provider.createInboxRule(rule), provider.createInboxRule(rule)]);
    await started.promise;
    failed.reject(new Error('Graph unavailable'));
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(get).toHaveBeenCalledTimes(1);
    expect(mock.post).not.toHaveBeenCalled();
    fail = false;
    await provider.createInboxRule(rule);
    expect(mock.post).toHaveBeenCalledWith('/me/mailFolders/inbox/messageRules',
      expect.objectContaining({ actions: { moveToFolder: 'retry' } }));
  });

  it('Scenario: Partial folder loads are shared but never cached', async () => {
    const started = deferred<void>();
    const root = deferred<ReturnType<typeof tree>>();
    let partial = true;
    const get = vi.fn(async () => {
      if (get.mock.calls.length === 1) { started.resolve(); return root.promise; }
      if (partial) return { value: [{ id: `f-${get.mock.calls.length}`, displayName: 'F', childFolderCount: 1 }] };
      return tree('complete');
    });
    const provider = new GraphEmailProvider(client(get));
    const first = provider.listFolders();
    const second = provider.listFolders();
    await started.promise;
    root.resolve({ value: [{ id: 'root', displayName: 'Root', childFolderCount: 1 }] });
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(get).toHaveBeenCalledTimes(400);
    partial = false;
    expect((await provider.listFolders()).map(folder => folder.id)).toEqual(['complete']);
    await provider.listFolders();
    expect(get).toHaveBeenCalledTimes(401);
  });

  it('Scenario: Folder cache expiry is measured from completed load', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const root = deferred<ReturnType<typeof tree>>();
    const started = deferred<void>();
    const get = vi.fn(() => { started.resolve(); return root.promise; });
    const provider = new GraphEmailProvider(client(get));
    const first = provider.listFolders();
    await started.promise;
    now.mockReturnValue(60_000);
    root.resolve(tree('id'));
    await first;
    now.mockReturnValue(119_999);
    await provider.listFolders();
    expect(get).toHaveBeenCalledTimes(1);
    now.mockReturnValue(120_000);
    await Promise.all([provider.listFolders(), provider.listFolders()]);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
