import { describe, expect, it, vi } from 'vitest';
import { GraphEmailProvider, GraphApiError, type GraphApiClient } from './email-graph-provider.js';

function createMockClient(overrides: Partial<GraphApiClient> = {}): GraphApiClient {
  return {
    get: vi.fn().mockResolvedValue({ value: [] }),
    post: vi.fn().mockResolvedValue({ id: 'new-id' }),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('provider-microsoft/Folder Management', () => {
  it('Scenario: Recursively traverses paginated roots and children with computed paths', async () => {
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?')) {
        return {
          value: [{ id: 'inbox-id', displayName: 'Inbox', childFolderCount: 1 }],
          '@odata.nextLink': 'https://graph.microsoft.com/root-page-2',
        };
      }
      if (url === 'https://graph.microsoft.com/root-page-2') {
        return { value: [{ id: 'archive-id', displayName: 'Archive', childFolderCount: 0 }] };
      }
      if (url.includes('/mailFolders/inbox-id/childFolders?')) {
        return {
          value: [{ id: 'news-id', displayName: 'Newsletters', childFolderCount: 1 }],
          '@odata.nextLink': 'https://graph.microsoft.com/inbox-children-page-2',
        };
      }
      if (url === 'https://graph.microsoft.com/inbox-children-page-2') {
        return { value: [{ id: 'receipts-id', displayName: 'Receipts', childFolderCount: 0 }] };
      }
      if (url.includes('/mailFolders/news-id/childFolders?')) {
        return { value: [{ id: 'promos-id', displayName: 'Promotions', childFolderCount: 0 }] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const provider = new GraphEmailProvider(createMockClient({ get }));

    const folders = await provider.listFolders();

    expect(folders.map(folder => [folder.id, folder.path])).toEqual([
      ['inbox-id', 'Inbox'],
      ['news-id', 'Inbox/Newsletters'],
      ['promos-id', 'Inbox/Newsletters/Promotions'],
      ['receipts-id', 'Inbox/Receipts'],
      ['archive-id', 'Archive'],
    ]);
  });

  it('Scenario: Repeated custom moves reuse the cached folder tree', async () => {
    const get = vi.fn().mockResolvedValue({
      value: [
        { id: 'inbox-id', displayName: 'Inbox', childFolderCount: 1 },
      ],
    });
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/me/mailFolders?')) {
        return { value: [{ id: 'inbox-id', displayName: 'Inbox', childFolderCount: 1 }] };
      }
      if (url.includes('/mailFolders/inbox-id/childFolders?')) {
        return { value: [{ id: 'news-id', displayName: 'Newsletters', childFolderCount: 0 }] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = createMockClient({ get });
    const provider = new GraphEmailProvider(client);

    await provider.moveToFolder('msg-1', 'Inbox/Newsletters');
    await provider.moveToFolder('msg-2', 'newsletters');

    expect(client.post).toHaveBeenNthCalledWith(1, '/me/messages/msg-1/move', { destinationId: 'news-id' });
    expect(client.post).toHaveBeenNthCalledWith(2, '/me/messages/msg-2/move', { destinationId: 'news-id' });
    // A move does not alter the folder tree, and triage loops move many
    // messages per pass — so moves resolve against the 60s cache. The first
    // move populates it (root + inbox children = 2 gets); the second is a cache
    // hit with no further traversal. Re-resolving per move would trip Graph
    // throttling on the exact high-volume loop this feature targets.
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Well-known moves retain alias behavior without folder traversal', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.moveToFolder('msg-1', 'trash');

    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledWith('/me/messages/msg-1/move', { destinationId: 'deleteditems' });
  });

  it('Scenario: Creating a child folder invalidates the resolver cache', async () => {
    let rootReads = 0;
    const get = vi.fn(async (url: string) => {
      if (!url.startsWith('/me/mailFolders?')) throw new Error(`Unexpected URL: ${url}`);
      rootReads++;
      return { value: [{ id: 'custom-id', displayName: 'Parent', childFolderCount: 0 }] };
    });
    const post = vi.fn().mockResolvedValue({
      id: 'child-id',
      displayName: 'Child',
      parentFolderId: 'custom-id',
      childFolderCount: 0,
    });
    const provider = new GraphEmailProvider(createMockClient({ get, post }));

    await provider.listFolders();
    const created = await provider.createFolder('Child', 'Parent');
    await provider.listFolders();

    expect(created.path).toBe('Parent/Child');
    expect(post).toHaveBeenCalledWith('/me/mailFolders/custom-id/childFolders', { displayName: 'Child' });
    // 1: initial listFolders. 2: write-path re-resolve of the parent.
    // 3: post-create listFolders, the cache having been invalidated.
    expect(rootReads).toBe(3);
  });

  it('Scenario: Refuses system folder deletion by well-known name', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await expect(provider.deleteFolder('sentitems')).rejects.toMatchObject({
      code: 'SYSTEM_FOLDER_PROTECTED',
    });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('Scenario: Refuses system folder deletion by resolved id', async () => {
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?')) {
        return { value: [{ id: 'inbox-opaque-id', displayName: 'Inbox', childFolderCount: 0 }] };
      }
      const match = url.match(/\/mailFolders\/([^?]+)/);
      const wellKnown = decodeURIComponent(match?.[1] ?? '');
      return {
        id: wellKnown === 'inbox' ? 'inbox-opaque-id' : `${wellKnown}-opaque-id`,
        displayName: wellKnown,
      };
    });
    const client = createMockClient({ get });
    const provider = new GraphEmailProvider(client);

    await expect(provider.deleteFolder('inbox-opaque-id')).rejects.toMatchObject({
      code: 'SYSTEM_FOLDER_PROTECTED',
    });
    expect(client.delete).not.toHaveBeenCalled();
  });
});

describe('provider-microsoft/Inbox Rule Management', () => {
  it('Scenario: Lists every paginated rule without stripping fields', async () => {
    const firstRule = {
      id: 'rule-1',
      actions: { forwardTo: [{ emailAddress: { address: 'outside@example.com' } }] },
      futureField: 'preserved',
    };
    const get = vi.fn()
      .mockResolvedValueOnce({ value: [firstRule], '@odata.nextLink': 'https://graph.microsoft.com/rules-page-2' })
      .mockResolvedValueOnce({ value: [{ id: 'rule-2', actions: { markAsRead: true } }] });
    const provider = new GraphEmailProvider(createMockClient({ get }));

    const rules = await provider.listInboxRules();

    expect(rules).toEqual([firstRule, { id: 'rule-2', actions: { markAsRead: true } }]);
    expect(get).toHaveBeenNthCalledWith(1, '/me/mailFolders/inbox/messageRules');
    expect(get).toHaveBeenNthCalledWith(2, 'https://graph.microsoft.com/rules-page-2');
  });

  it('Scenario: Creates a rule after resolving its custom move destination', async () => {
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?')) {
        return { value: [{ id: 'news-id', displayName: 'Newsletters', childFolderCount: 0 }] };
      }
      // The destination is re-checked against resolved system folder ids, so a
      // custom folder can't sneak through by mapping onto a system folder.
      const systemLookup = /^\/me\/mailFolders\/([a-z]+)\?/.exec(url);
      if (systemLookup) return { id: `system-${systemLookup[1]}` };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const post = vi.fn().mockResolvedValue({ id: 'rule-1', displayName: 'GitHub' });
    const provider = new GraphEmailProvider(createMockClient({ get, post }));

    await provider.createInboxRule({
      displayName: 'GitHub',
      conditions: { senderContains: ['github.com'] },
      actions: { moveToFolder: 'Newsletters', markAsRead: true },
    });

    expect(post).toHaveBeenCalledWith('/me/mailFolders/inbox/messageRules', {
      displayName: 'GitHub',
      conditions: { senderContains: ['github.com'] },
      actions: { moveToFolder: 'news-id', markAsRead: true },
    });
  });

  it('Scenario: Rejects unsafe actions even when the provider is called directly', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await expect(provider.createInboxRule({
      displayName: 'Unsafe',
      conditions: {},
      actions: { redirectTo: [] },
    })).rejects.toMatchObject({ code: 'UNSAFE_RULE_ACTION' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('Scenario: Deletes a rule using an encoded id', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.deleteInboxRule('rule/+=id');

    expect(client.delete).toHaveBeenCalledWith(
      '/me/mailFolders/inbox/messageRules/rule%2F%2B%3Did',
    );
  });
});

describe('provider-microsoft/Peer-review hardening (PR #106)', () => {
  it('Scenario: Rejects case-variant forwarding actions called directly on the provider', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // Graph treats JSON keys case-insensitively, so a case-sensitive blocklist
    // would let these provision a real exfiltrating rule.
    for (const key of ['ForwardTo', 'REDIRECTTO', 'forwardAsAttachmentTo', ' Delete ']) {
      await expect(provider.createInboxRule({
        displayName: 'Bypass attempt',
        conditions: {},
        actions: { [key]: [{ emailAddress: { address: 'attacker@evil.com' } }] },
      })).rejects.toMatchObject({ code: 'UNSAFE_RULE_ACTION' });
    }
    expect(client.post).not.toHaveBeenCalled();
  });

  it('Scenario: Fails closed on rule actions outside the safe allowlist', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await expect(provider.createInboxRule({
      displayName: 'Unknown future Graph action',
      conditions: {},
      actions: { someFutureAction: true },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_RULE_ACTION' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('Scenario: Caps total Graph requests across a wide recursive folder tree', async () => {
    // Every folder claims a child, so an uncapped traversal recurses forever.
    const get = vi.fn(async () => ({
      value: [{ id: `f-${get.mock.calls.length}`, displayName: `F${get.mock.calls.length}`, childFolderCount: 1 }],
    }));
    const provider = new GraphEmailProvider(createMockClient({ get }));

    // Truncates rather than throwing: a partial list beats a hard failure.
    const folders = await provider.listFolders();
    expect(folders.length).toBeGreaterThan(0);
    // Budget is shared across the recursion, not reset per collection.
    expect(get.mock.calls.length).toBeLessThanOrEqual(400);
  });
});

describe('provider-microsoft/Destructive rule destinations (PR #106 review)', () => {
  it('Scenario: Blocks a rule that files mail into Deleted Items via any alias', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // `trash`/`deleted` both resolve to deleteditems — a `delete` action in
    // disguise, and with empty conditions it would discard the whole mailbox.
    for (const destination of ['trash', 'deleted', 'DeletedItems', ' Trash ']) {
      await expect(provider.createInboxRule({
        displayName: 'Discard everything',
        conditions: {},
        actions: { moveToFolder: destination },
      })).rejects.toMatchObject({ code: 'UNSAFE_RULE_DESTINATION' });
    }
    expect(client.post).not.toHaveBeenCalled();
  });

  it('Scenario: Does not cache a truncated folder snapshot', async () => {
    let calls = 0;
    const get = vi.fn(async () => {
      calls += 1;
      // First traversal is unbounded-wide (forces truncation); afterwards the
      // mailbox settles into a single small folder.
      if (calls < 405) {
        return { value: [{ id: `f-${calls}`, displayName: `F${calls}`, childFolderCount: 1 }] };
      }
      return { value: [{ id: 'real-id', displayName: 'Newsletters', childFolderCount: 0 }] };
    });
    const provider = new GraphEmailProvider(createMockClient({ get }));

    await provider.listFolders();
    const before = get.mock.calls.length;
    await provider.listFolders();
    // A cached truncated tree would have made the second call free — and would
    // have made "folder not found" sticky for 60s on folders that do exist.
    expect(get.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('provider-microsoft/Round-2 review hardening (PR #106)', () => {
  it('Scenario: Case-variant moveToFolder to trash cannot bypass the destructive check', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // Graph is case-insensitive, so `MoveToFolder` passes the normalized
    // allowlist. The destructive-destination check must see it too — a
    // case-sensitive lookup here would let it file the mailbox into trash.
    for (const key of ['MoveToFolder', 'MOVETOFOLDER', 'movetofolder']) {
      await expect(provider.createInboxRule({
        displayName: 'Discard via case trick',
        conditions: {},
        actions: { [key]: 'trash' },
      })).rejects.toMatchObject({ code: 'UNSAFE_RULE_DESTINATION' });
    }
    expect(client.post).not.toHaveBeenCalled();
  });

  it('Scenario: Rules moving mail to Archive or Junk are allowed, not over-blocked', async () => {
    // getSystemFolderIdMap resolves each well-known name; archive/junkemail are
    // legitimate rule destinations and must survive the destructive-id re-check.
    const get = vi.fn(async (url: string) => {
      const m = /\/me\/mailFolders\/([a-z]+)\?/.exec(url);
      if (m) return { id: `system-${m[1]}` };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const post = vi.fn().mockResolvedValue({ id: 'rule-1', displayName: 'Archive old' });
    const provider = new GraphEmailProvider(createMockClient({ get, post }));

    for (const destination of ['archive', 'junkemail']) {
      const rule = await provider.createInboxRule({
        displayName: `File to ${destination}`,
        conditions: {},
        actions: { moveToFolder: destination },
      });
      expect(rule).toMatchObject({ id: 'rule-1' });
    }
    // Rule destinations resolve to opaque ids (Graph's rule contract wants an
    // id, not a well-known name). Archive/Junk are legitimate and must NOT be
    // rejected by the destructive re-check, which covers only deleted-items.
    expect(post).toHaveBeenNthCalledWith(1, '/me/mailFolders/inbox/messageRules',
      expect.objectContaining({ actions: { moveToFolder: 'system-archive' } }));
    expect(post).toHaveBeenNthCalledWith(2, '/me/mailFolders/inbox/messageRules',
      expect.objectContaining({ actions: { moveToFolder: 'system-junkemail' } }));
  });

  it('Scenario: Mis-cased action keys are canonicalized before hitting Graph', async () => {
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?')) {
        return { value: [{ id: 'news-id', displayName: 'Newsletters', childFolderCount: 0 }] };
      }
      const m = /\/me\/mailFolders\/([a-z]+)\?/.exec(url);
      if (m) return { id: `system-${m[1]}` };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const post = vi.fn().mockResolvedValue({ id: 'rule-1', displayName: 'GitHub' });
    const provider = new GraphEmailProvider(createMockClient({ get, post }));

    await provider.createInboxRule({
      displayName: 'GitHub',
      conditions: {},
      actions: { MoveToFolder: 'Newsletters', MarkAsRead: true },
    });

    expect(post).toHaveBeenCalledWith('/me/mailFolders/inbox/messageRules',
      expect.objectContaining({ actions: { moveToFolder: 'news-id', markAsRead: true } }));
  });
});

describe('provider-microsoft/Round-2 Codex probes (PR #106)', () => {
  const systemIdMock = (extra?: (url: string) => unknown) => vi.fn(async (url: string) => {
    if (extra) {
      const r = extra(url);
      if (r !== undefined) return r;
    }
    const m = /\/me\/mailFolders\/([a-z]+)\?/.exec(url);
    if (m) return { id: `system-${m[1]}` };
    throw new Error(`Unexpected URL: ${url}`);
  });

  it('Scenario: Slash/alias-padded destructive destinations cannot bypass the check', async () => {
    // `/trash/`, `/deleteditems/` etc. normalize to the deleted-items folder
    // once surrounding slashes are stripped — they must be rejected.
    for (const destination of ['/trash/', '/deleteditems/', '  /Deleted/  ', '/recoverableitemsdeletions/']) {
      const post = vi.fn();
      const provider = new GraphEmailProvider(createMockClient({ get: systemIdMock(), post }));
      await expect(provider.createInboxRule({
        displayName: 'Slash bypass',
        conditions: {},
        actions: { moveToFolder: destination },
      })).rejects.toMatchObject({ code: 'UNSAFE_RULE_DESTINATION' });
      expect(post).not.toHaveBeenCalled();
    }
  });

  it('Scenario: Wrong-typed action values fail closed before hitting Graph', async () => {
    const cases: Array<Record<string, unknown>> = [
      { moveToFolder: true },
      { markAsRead: 'false' },
      { markImportance: 'urgent' },
      { assignCategories: 'work' },
      { copyToFolder: 42 },
    ];
    for (const actions of cases) {
      const post = vi.fn();
      const provider = new GraphEmailProvider(createMockClient({ get: systemIdMock(), post }));
      await expect(provider.createInboxRule({
        displayName: 'Bad value', conditions: {}, actions,
      })).rejects.toMatchObject({ code: 'INVALID_RULE_ACTION_VALUE' });
      expect(post).not.toHaveBeenCalled();
    }
  });

  it('Scenario: A truncated tree refuses a name match rather than misrouting a move', async () => {
    // Every folder claims a child so the traversal truncates; the target name
    // is visible but cannot be proven unique, so resolution must refuse.
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?') || url.includes('/childFolders?')) {
        return { value: [{ id: `f-${get.mock.calls.length}`, displayName: 'Target', childFolderCount: 1 }] };
      }
      // 'Target' is a name, not an id — the direct-GET fallback 404s.
      throw new GraphApiError(404, 'ErrorItemNotFound');
    });
    const provider = new GraphEmailProvider(createMockClient({ get }));

    await expect(provider.moveToFolder('msg-1', 'Target')).rejects.toMatchObject({
      code: 'FOLDER_TRAVERSAL_LIMIT',
    });
  });

  it('Scenario: An exact folder id resolves even when it lies beyond the truncation prefix', async () => {
    // The wanted id is NEVER in the traversed tree (every listed folder is a
    // decoy that claims a child, forcing truncation). Resolution must fall back
    // to a direct GET of the id rather than failing with FOLDER_TRAVERSAL_LIMIT.
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?') || url.includes('/childFolders?')) {
        const n = get.mock.calls.length;
        return { value: [{ id: `decoy-${n}`, displayName: `F${n}`, childFolderCount: 1 }] };
      }
      // Direct single-folder GET fallback for the exact id.
      if (url.includes('/mailFolders/wanted-id')) return { id: 'wanted-id' };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const post = vi.fn().mockResolvedValue({ id: 'moved-id' });
    const provider = new GraphEmailProvider(createMockClient({ get, post }));

    const newId = await provider.moveToFolder('msg-1', 'wanted-id');
    expect(newId).toBe('moved-id');
    expect(post).toHaveBeenCalledWith('/me/messages/msg-1/move', { destinationId: 'wanted-id' });
  });

  it('Scenario: A non-id name beyond the truncation prefix still fails closed', async () => {
    // The direct-GET fallback 404s for a name, so we must NOT misroute — the
    // move fails with FOLDER_TRAVERSAL_LIMIT rather than guessing.
    const get = vi.fn(async (url: string) => {
      if (url.startsWith('/me/mailFolders?') || url.includes('/childFolders?')) {
        const n = get.mock.calls.length;
        return { value: [{ id: `decoy-${n}`, displayName: `F${n}`, childFolderCount: 1 }] };
      }
      throw new GraphApiError(404, 'ErrorItemNotFound');
    });
    const post = vi.fn();
    const provider = new GraphEmailProvider(createMockClient({ get, post }));

    await expect(provider.moveToFolder('msg-1', 'Some Folder Name')).rejects.toMatchObject({
      code: 'FOLDER_TRAVERSAL_LIMIT',
    });
    expect(post).not.toHaveBeenCalled();
  });
});
