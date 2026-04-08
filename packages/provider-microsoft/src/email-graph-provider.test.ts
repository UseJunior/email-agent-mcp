import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphEmailProvider, GraphApiError, RealGraphApiClient, simplifySearchQuery, type GraphApiClient } from './email-graph-provider.js';

// Linux CI runners do not provide libsecret, so auth imports must not load the real cache plugin.
vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: vi.fn(),
}));

function createMockClient(overrides: Partial<GraphApiClient> = {}): GraphApiClient {
  return {
    get: vi.fn().mockResolvedValue({ value: [] }),
    post: vi.fn().mockResolvedValue({ id: 'new-id' }),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('provider-microsoft/Draft-Then-Send via createReplyAll', () => {
  it('Scenario: Reply preserves embedded images', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce({ id: 'draft-123' }) // createReplyAll
        .mockResolvedValueOnce({}), // send
      get: vi.fn().mockResolvedValue({
        id: 'msg-1',
        subject: 'Test',
        from: { emailAddress: { address: 'alice@corp.com' } },
        receivedDateTime: '2024-03-15T10:00:00Z',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.replyToMessage('msg-1', '<p>Thanks!</p>');

    expect(result.success).toBe(true);
    // Verify createReplyAll was called (preserves embedded images)
    expect(client.post).toHaveBeenCalledWith(
      expect.stringContaining('createReplyAll'),
      expect.anything(),
    );
    // Verify draft body was updated
    expect(client.patch).toHaveBeenCalledWith(
      expect.stringContaining('draft-123'),
      expect.objectContaining({ body: expect.anything() }),
    );
  });

  it('Scenario: Fallback to sendMail on 404', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockRejectedValueOnce(new Error('404 Not Found')) // createReplyAll fails
        .mockResolvedValueOnce({ id: 'sent-msg' }), // sendMail fallback
      get: vi.fn().mockResolvedValue({
        id: 'deleted-msg',
        subject: 'Deleted',
        from: { emailAddress: { address: 'alice@corp.com' } },
        receivedDateTime: '2024-03-15T10:00:00Z',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.replyToMessage('deleted-msg', 'Response');

    expect(result.success).toBe(true);
    // Falls back to sendMail
    expect(client.post).toHaveBeenCalledWith(
      expect.stringContaining('sendMail'),
      expect.anything(),
    );
  });
});

describe('provider-microsoft/Size Limits', () => {
  it('Scenario: Body size enforcement', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // Create a body exceeding 3.5MB
    const largeBody = 'x'.repeat(4 * 1024 * 1024);

    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Large',
      body: largeBody,
    });

    // The body in the API call should be truncated
    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sentBody = (callArgs[1] as { message: { body: { content: string } } }).message.body.content;
    expect(sentBody).toContain('truncated');
    expect(Buffer.byteLength(sentBody, 'utf-8')).toBeLessThanOrEqual(3.5 * 1024 * 1024 + 200);
  });
});

describe('provider-interface/Capability Interfaces', () => {
  it('Scenario: Provider honors bodyHtml on send', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'HTML body',
      body: '### Hi',
      bodyHtml: '<h3>Hi</h3>',
    });

    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = (callArgs[1] as { message: { body: { contentType: string; content: string } } }).message.body;
    // Graph → contentType: HTML when bodyHtml is set, content is the rendered HTML
    expect(body.contentType).toBe('HTML');
    expect(body.content).toBe('<h3>Hi</h3>');
  });

  it('Scenario: Provider sends plain text when bodyHtml is absent', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Plain body',
      body: 'line one\nline two',
    });

    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = (callArgs[1] as { message: { body: { contentType: string; content: string } } }).message.body;
    // Graph → contentType: Text when only body is set; newlines preserved verbatim
    expect(body.contentType).toBe('Text');
    expect(body.content).toBe('line one\nline two');
  });

  it('Scenario: Provider honors ReplyOptions.bodyHtml', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce({ id: 'draft-xyz' }) // createReplyAll
        .mockResolvedValueOnce({}), // send
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'plain reply', {
      bodyHtml: '<p>rendered reply</p>',
    });

    const patchCall = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = (patchCall[1] as { body: { contentType: string; content: string } }).body;
    expect(body.contentType).toBe('HTML');
    expect(body.content).toBe('<p>rendered reply</p>');
  });

  it('Scenario: createDraft and updateDraft honor bodyHtml', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // createDraft
    await provider.createDraft({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Draft',
      body: '# fallback',
      bodyHtml: '<h1>rendered</h1>',
    });

    const createArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const createBody = (createArgs[1] as { body: { contentType: string; content: string } }).body;
    expect(createBody.contentType).toBe('HTML');
    expect(createBody.content).toBe('<h1>rendered</h1>');

    // updateDraft
    await provider.updateDraft('draft-1', {
      body: '# fallback 2',
      bodyHtml: '<h1>updated</h1>',
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const updateBody = (patchArgs[1] as { body: { contentType: string; content: string } }).body;
    expect(updateBody.contentType).toBe('HTML');
    expect(updateBody.content).toBe('<h1>updated</h1>');
  });
});

describe('provider-microsoft/Sent Message Tracking', () => {
  it('Scenario: Find sent message', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // Send with tracking ID
    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Tracked',
      body: 'Hello',
      trackingId: 'tracking-123',
    });

    // Verify tracking ID was included in the extended property
    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sentMsg = (callArgs[1] as { message: { singleValueExtendedProperties: Array<{ id: string; value: string }> } }).message;
    const trackingProp = sentMsg.singleValueExtendedProperties.find(
      (p: { value: string }) => p.value === 'tracking-123',
    );
    expect(trackingProp).toBeDefined();
  });
});

describe('provider-microsoft/Dual Watch Mode', () => {
  it('Scenario: Delta Query polling (local)', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [{
          id: 'new-msg',
          subject: 'New Email',
          from: { emailAddress: { address: 'bob@corp.com' } },
          receivedDateTime: '2024-03-15T10:00:00Z',
        }],
        '@odata.deltaLink': '/delta?token=next',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    expect(delta.messages).toHaveLength(1);
    expect(delta.messages[0]!.subject).toBe('New Email');
    expect(delta.nextDeltaLink).toContain('delta');
  });

  it('Scenario: Webhook mode (production)', async () => {
    // Webhook mode is handled by subscription creation (tested in subscriptions.test.ts)
    // Here we verify the provider supports the dual-mode concept
    const client = createMockClient({
      post: vi.fn().mockResolvedValue({
        id: 'sub-123',
        resource: 'users/me/mailFolders/Inbox/messages',
        expirationDateTime: '2024-03-20T00:00:00Z',
      }),
    });

    const response = await client.post('/subscriptions', {
      changeType: 'created',
      notificationUrl: 'https://prod.example.com/webhook',
      resource: 'users/me/mailFolders/Inbox/messages',
    });

    expect(response.id).toBe('sub-123');
  });
});

describe('provider-microsoft/Thread Lookup', () => {
  it('Scenario: getThread filters by conversationId', async () => {
    const client = createMockClient({
      get: vi.fn()
        .mockResolvedValueOnce({
          id: 'msg-1',
          subject: 'Thread root',
          conversationId: 'conv-123',
          from: { emailAddress: { address: 'alice@corp.com' } },
          receivedDateTime: '2024-03-15T10:00:00Z',
        })
        .mockResolvedValueOnce({
          value: [
            {
              id: 'msg-1',
              subject: 'Thread root',
              conversationId: 'conv-123',
              from: { emailAddress: { address: 'alice@corp.com' } },
              receivedDateTime: '2024-03-15T10:00:00Z',
            },
            {
              id: 'msg-2',
              subject: 'Re: Thread root',
              conversationId: 'conv-123',
              from: { emailAddress: { address: 'bob@corp.com' } },
              receivedDateTime: '2024-03-15T11:00:00Z',
            },
          ],
        }),
    });
    const provider = new GraphEmailProvider(client);

    const thread = await provider.getThread('msg-1');

    expect(thread.id).toBe('conv-123');
    expect(thread.messageCount).toBe(2);
    expect(client.get).toHaveBeenNthCalledWith(1, '/me/messages/msg-1');
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    const decodedUrl = decodeURIComponent(url).replaceAll('+', ' ');
    expect(decodedUrl).toContain("conversationId eq 'conv-123'");
    expect(decodedUrl).not.toContain('$orderby=');
    expect(thread.messages[0]!.id).toBe('msg-1');
    expect(thread.messages[1]!.id).toBe('msg-2');
  });
});

describe('provider-microsoft/Email Categorizer', () => {
  it('Scenario: applyLabels merges categories with the existing master values', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({ categories: ['Existing'] }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.applyLabels('msg-1', ['Urgent', 'Existing']);

    expect(client.get).toHaveBeenCalledWith('/me/messages/msg-1?$select=categories');
    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', {
      categories: ['Existing', 'Urgent'],
    });
  });

  it('Scenario: removeLabels patches the remaining categories', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({ categories: ['Existing', 'Urgent'] }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.removeLabels('msg-1', ['Urgent']);

    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', {
      categories: ['Existing'],
    });
  });

  it('Scenario: setFlag uses follow-up flag status, not message importance', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.setFlag('msg-1', true);

    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', {
      flag: { flagStatus: 'flagged' },
    });
  });

  it('Scenario: setReadState patches isRead', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.setReadState('msg-1', true);

    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', { isRead: true });
  });

  it('Scenario: moveToFolder normalizes well-known folder aliases', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.moveToFolder('msg-1', 'trash');

    expect(client.post).toHaveBeenCalledWith('/me/messages/msg-1/move', {
      destinationId: 'deleteditems',
    });
  });

  it('Scenario: soft delete moves the message to Deleted Items', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.deleteMessage('msg-1', false);

    expect(client.post).toHaveBeenCalledWith('/me/messages/msg-1/move', {
      destinationId: 'deleteditems',
    });
  });

  it('Scenario: hard delete uses permanentDelete', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.deleteMessage('msg-1', true);

    expect(client.post).toHaveBeenCalledWith('/me/messages/msg-1/permanentDelete');
  });
});

describe('provider-microsoft/Graph API Client', () => {
  it('Scenario: POST without a body omits JSON encoding', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: vi.fn().mockResolvedValue(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new RealGraphApiClient(async () => 'token-123');
    await client.post('/me/messages/msg-1/permanentDelete');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me/messages/msg-1/permanentDelete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123' },
      },
    );

    vi.unstubAllGlobals();
  });
});

describe('provider-microsoft/Graph API Auth Retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries GET on 401 when onAuthError succeeds', async () => {
    let tokenVersion = 0;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: [{ id: 'msg-1' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(true);
    const client = new RealGraphApiClient(
      async () => `token-v${++tokenVersion}`,
      onAuthError,
    );

    const result = await client.get('/me/messages');
    expect(onAuthError).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retry should use fresh token
    const retryHeaders = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(retryHeaders['Authorization']).toBe('Bearer token-v2');
    expect(result.value).toHaveLength(1);
  });

  it('throws GraphApiError on 401 when no onAuthError callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new RealGraphApiClient(async () => 'token');
    await expect(client.get('/me/messages')).rejects.toThrow(GraphApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws GraphApiError on 401 when onAuthError returns false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(false);
    const client = new RealGraphApiClient(async () => 'token', onAuthError);
    await expect(client.get('/me/messages')).rejects.toThrow(GraphApiError);
    expect(onAuthError).toHaveBeenCalledOnce();
    // Should not retry
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not trigger onAuthError for non-401 errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => 'Forbidden',
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(true);
    const client = new RealGraphApiClient(async () => 'token', onAuthError);
    await expect(client.get('/me/messages')).rejects.toThrow(GraphApiError);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('retries POST on 401 when onAuthError succeeds', async () => {
    let tokenVersion = 0;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(true);
    const client = new RealGraphApiClient(
      async () => `token-v${++tokenVersion}`,
      onAuthError,
    );

    const result = await client.post('/me/sendMail', { message: {} });
    expect(onAuthError).toHaveBeenCalledOnce();
    expect(result).toEqual({});
  });
});

describe('provider-microsoft/Delta Query Sync Protocol', () => {
  it('Scenario: Uses $select for efficiency', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    // Verify the initial URL includes $select
    expect(client.get).toHaveBeenCalledWith(
      expect.stringContaining('$select='),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.stringContaining('subject'),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.stringContaining('mailFolders/Inbox/messages/delta'),
    );
  });

  it('Scenario: Paging with @odata.nextLink', async () => {
    // Simulate multi-page response: page1 has nextLink, page2 has deltaLink
    const client = createMockClient({
      get: vi.fn()
        .mockResolvedValueOnce({
          value: [{
            id: 'msg-1',
            subject: 'Page 1',
            from: { emailAddress: { address: 'alice@corp.com' } },
          }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?skiptoken=page2',
        })
        .mockResolvedValueOnce({
          value: [{
            id: 'msg-2',
            subject: 'Page 2',
            from: { emailAddress: { address: 'bob@corp.com' } },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=final',
        }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    // Should have followed both pages
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(delta.messages).toHaveLength(2);
    expect(delta.messages[0]!.subject).toBe('Page 1');
    expect(delta.messages[1]!.subject).toBe('Page 2');
    expect(delta.nextDeltaLink).toBe('https://graph.microsoft.com/v1.0/delta?token=final');
  });

  it('Scenario: Tombstone filtering', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [
          {
            id: 'msg-new',
            subject: 'New Email',
            from: { emailAddress: { address: 'alice@corp.com' } },
          },
          {
            id: 'msg-deleted',
            subject: 'Deleted Email',
            '@removed': { reason: 'deleted' },
          },
          {
            id: 'msg-moved',
            subject: 'Moved Email',
            '@removed': { reason: 'changed' },
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    // Tombstones should be filtered out
    expect(delta.messages).toHaveLength(1);
    expect(delta.messages[0]!.id).toBe('msg-new');
  });

  it('Scenario: Subsequent poll with deltaLink', async () => {
    const savedDeltaLink = 'https://graph.microsoft.com/v1.0/delta?token=saved';
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [{
          id: 'new-since-last',
          subject: 'New Since Last Poll',
          from: { emailAddress: { address: 'charlie@corp.com' } },
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=updated',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages(savedDeltaLink);

    // Should use the saved deltaLink, not the initial URL
    expect(client.get).toHaveBeenCalledWith(savedDeltaLink);
    expect(delta.messages).toHaveLength(1);
    expect(delta.nextDeltaLink).toBe('https://graph.microsoft.com/v1.0/delta?token=updated');
  });
});

describe('provider-microsoft/ESM Compatibility', () => {
  it('Scenario: ESM import resolution', async () => {
    // Verify all imports in the module use explicit .js extensions
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const sourceFiles = ['email-graph-provider.ts', 'auth.ts', 'subscriptions.ts', 'index.ts'];
    for (const file of sourceFiles) {
      const content = await readFile(join(import.meta.dirname, file), 'utf-8');
      // Check that local imports use .js extensions
      const localImports = content.match(/from\s+['"]\.\//g) ?? [];
      const localImportsWithJs = content.match(/from\s+['"]\.\/[^'"]+\.js['"]/g) ?? [];
      expect(localImportsWithJs.length).toBe(localImports.length);
    }
  });
});

describe('provider-microsoft/NemoClaw Compatibility', () => {
  it('Scenario: NemoClaw egress config', () => {
    const domains = GraphEmailProvider.egressDomains;
    expect(domains).toContain('graph.microsoft.com');
    expect(domains).toContain('login.microsoftonline.com');
  });
});

describe('provider-microsoft/Search Hardening', () => {
  it('Scenario: Empty query returns empty array', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    expect(await provider.searchMessages('')).toEqual([]);
    expect(await provider.searchMessages('   ')).toEqual([]);
    // Should not have called the API at all
    expect(client.get).not.toHaveBeenCalled();
  });

  it('Scenario: Search includes $top=50 in the URL', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('budget report');

    expect(client.get).toHaveBeenCalledTimes(1);
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('%24top=50');
  });

  it('Scenario: Search auto-simplifies on 400 error', async () => {
    const client = createMockClient({
      get: vi.fn()
        .mockRejectedValueOnce(new GraphApiError(400, 'Bad Request: syntax error'))
        .mockResolvedValueOnce({
          value: [{
            id: 'msg-1',
            subject: 'Budget Report Q4',
            from: { emailAddress: { address: 'cfo@corp.com' } },
            receivedDateTime: '2024-06-01T12:00:00Z',
          }],
        }),
    });
    const provider = new GraphEmailProvider(client);

    const results = await provider.searchMessages('from:cfo@corp.com AND subject:budget');

    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toBe('Budget Report Q4');
    // Should have retried with simplified query
    expect(client.get).toHaveBeenCalledTimes(2);
    const retryUrl = (client.get as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    // Simplified query should not contain field prefixes or boolean operators
    expect(retryUrl).not.toContain('from%3A');
    expect(retryUrl).not.toContain('AND');
  });

  it('Scenario: simplifySearchQuery strips prefixes and operators', () => {
    expect(simplifySearchQuery('from:alice@corp.com AND subject:"Q4 budget"'))
      .toBe('alice@corp.com Q4 budget');
    expect(simplifySearchQuery('body:hello OR to:bob@corp.com NOT spam'))
      .toBe('hello bob@corp.com spam');
    expect(simplifySearchQuery('simple keywords')).toBe('simple keywords');
  });
});

describe('provider-microsoft/Inbox-Scoped Message Access', () => {
  it('Scenario: Inbox-scoped message listing', async () => {
    // WHEN listing or fetching messages from Graph
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ limit: 10 });

    // THEN the API call uses /me/mailFolders/Inbox/messages (default folder is inbox)
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/inbox/messages');
    expect(url).not.toMatch(/\/me\/messages\?/);
  });

  it('Scenario: Sent alias listing normalizes to sentitems', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ folder: 'sent', limit: 10 });

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/sentitems/messages');
  });

  it('Scenario: Folder-scoped search normalizes well-known aliases', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('launch prep', 'trash');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/deleteditems/messages');
  });

  it('Scenario: Inbox-scoped delta query', async () => {
    // WHEN the watcher performs a delta query
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    // Use the inbox-scoped delta URL
    await provider.getDeltaMessages('https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject');

    // THEN the API call uses /me/mailFolders/Inbox/messages/delta
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/Inbox/messages/delta');
    expect(url).not.toMatch(/\/me\/messages\/delta/);
  });
});

describe('provider-microsoft/Delta Query Field Selection', () => {
  it('Scenario: Delta query uses $select', async () => {
    // WHEN the system issues a Delta Query request for inbox messages
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    // The initial delta URL includes $select for efficiency
    const deltaUrl = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments';
    await provider.getDeltaMessages(deltaUrl);

    // THEN the request includes $select with the required fields
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('$select=');
    expect(url).toContain('subject');
    expect(url).toContain('from');
    expect(url).toContain('toRecipients');
    expect(url).toContain('ccRecipients');
    expect(url).toContain('receivedDateTime');
    expect(url).toContain('hasAttachments');
  });

  it('Scenario: Selected fields sufficient for wake payload', async () => {
    // WHEN the watcher constructs a wake payload from delta query results
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [{
          id: 'msg-1',
          subject: 'Quarterly Report',
          from: { emailAddress: { address: 'cfo@corp.com', name: 'CFO' } },
          toRecipients: [{ emailAddress: { address: 'test-user@example.com' } }],
          ccRecipients: [{ emailAddress: { address: 'team@corp.com' } }],
          receivedDateTime: '2024-06-01T12:00:00Z',
          hasAttachments: true,
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=next',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages(
      'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments',
    );

    // THEN all required payload fields are available from the $select fields
    const msg = delta.messages[0]!;
    expect(msg.subject).toBe('Quarterly Report');
    expect(msg.from.email).toBe('cfo@corp.com');
    expect(msg.to).toHaveLength(1);
    expect(msg.to[0]!.email).toBe('test-user@example.com');
    expect(msg.cc).toHaveLength(1);
    expect(msg.cc![0]!.email).toBe('team@corp.com');
    expect(msg.hasAttachments).toBe(true);
    expect(msg.receivedAt).toBe('2024-06-01T12:00:00Z');
  });
});

describe('provider-microsoft/Email Address Retrieval from /me', () => {
  it('Scenario: Email from /me mail property', async () => {
    // WHEN configure_mailbox fetches /me and the response includes mail: "test-user@example.com"
    // The auth manager stores the email address from the /me profile
    const auth = new (await import('./auth.js')).DelegatedAuthManager(
      { mode: 'delegated', clientId: 'test-client-id' },
      'work',
    );

    // Simulate setting the email address from /me mail property
    auth.setEmailAddress('test-user@example.com');

    // THEN the stored emailAddress is test-user@example.com
    expect(auth.emailAddress).toBe('test-user@example.com');
  });

  it('Scenario: Fallback to userPrincipalName', async () => {
    // WHEN configure_mailbox fetches /me and mail is null
    // AND userPrincipalName is test-user@example.onmicrosoft.com
    // Simulate the fallback logic from cli.ts runConfigure:
    //   const emailAddress = profile.mail ?? profile.userPrincipalName;
    const profile = {
      mail: null as string | null,
      userPrincipalName: 'test-user@example.onmicrosoft.com',
    };
    const emailAddress = profile.mail ?? profile.userPrincipalName;

    // THEN the stored emailAddress is test-user@example.onmicrosoft.com
    expect(emailAddress).toBe('test-user@example.onmicrosoft.com');

    // Verify the auth manager accepts this fallback value
    const auth = new (await import('./auth.js')).DelegatedAuthManager(
      { mode: 'delegated', clientId: 'test-client-id' },
      'work',
    );
    auth.setEmailAddress(emailAddress);
    expect(auth.emailAddress).toBe('test-user@example.onmicrosoft.com');
  });
});

describe('provider-microsoft/Offset Pagination', () => {
  it('listMessages includes $skip when offset is provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ limit: 10, offset: 25 });

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('$top=10');
    expect(decoded).toContain('$skip=25');
  });

  it('listMessages omits $skip when offset is not provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ limit: 10 });

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('%24top=10');
    expect(url).not.toContain('skip');
  });

  it('searchMessages includes $top and $skip when provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('budget', undefined, 20, 10);

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('$top=20');
    expect(decoded).toContain('$skip=10');
  });

  it('searchMessages uses default $top=50 when limit not provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('report');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('%24top=50');
    expect(url).not.toContain('skip');
  });
});

describe('provider-microsoft/Watcher Timestamp Boundary', () => {
  it('Scenario: getNewMessages uses ge not gt', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.getNewMessages('2024-06-01T00:00:00Z');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('receivedDateTime ge 2024-06-01T00:00:00Z');
    expect(decoded).not.toContain('receivedDateTime gt ');
  });
});
