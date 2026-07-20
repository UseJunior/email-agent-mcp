import { describe, expect, it, vi } from 'vitest';
import { GraphEmailProvider, type GraphApiClient } from './email-graph-provider.js';

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

  it('Scenario: Custom moves resolve a path and reuse the 60-second folder cache', async () => {
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
    expect(rootReads).toBe(2);
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
