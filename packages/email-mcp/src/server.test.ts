import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { deleteEmailAction } from '@usejunior/email-core';
import {
  actionsToMcpTools,
  handleToolCall,
  executeTool,
  getActionInputJsonSchema,
  getServerManifest,
  createLazyProviderState,
  waitForInit,
  ensureProvider,
  buildLazyActions,
  coerceArgsForZod,
  type EmailActionDef,
  type LazyProviderState,
} from './server.js';

// Create test actions that mimic the email-core action pattern
const testActions: EmailActionDef[] = [
  {
    name: 'list_emails',
    description: 'List recent emails',
    input: z.object({ unread: z.boolean().optional(), limit: z.number().optional() }),
    output: z.object({ emails: z.array(z.object({ id: z.string() })) }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    run: async (_ctx, _input) => ({ emails: [{ id: 'msg-1' }] }),
  },
  {
    name: 'send_email',
    description: 'Send a new email',
    input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    output: z.object({ success: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (_ctx, _input) => ({ success: true }),
  },
];

describe('mcp-transport/executeTool primitive', () => {
  it('Scenario: executeTool returns raw action result without MCP envelope', async () => {
    // Both `serve` (via handleToolCall) and `call` (via the CLI) dispatch through
    // executeTool. The raw shape MUST be free of MCP transport formatting so the
    // CLI can emit it directly while handleToolCall layers the envelope on top.
    const { result, input } = await executeTool(testActions, {}, 'list_emails', { unread: true });
    expect(result).toEqual({ emails: [{ id: 'msg-1' }] });
    expect(input).toEqual({ unread: true });
  });

  it('Scenario: executeTool throws on unknown tool', async () => {
    await expect(executeTool(testActions, {}, 'nonexistent', {}))
      .rejects.toThrow(/Unknown tool/);
  });

  it('Scenario: handleToolCall wraps executeTool result in MCP content envelope', async () => {
    // Regression: handleToolCall must continue to produce the MCP `content` envelope
    // after the executeTool extraction.
    const result = await handleToolCall(testActions, {}, 'list_emails', { unread: true });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.emails).toEqual([{ id: 'msg-1' }]);
  });

  it('Scenario: getActionInputJsonSchema returns JSON Schema for `call <tool> --schema`', () => {
    const action = testActions.find(a => a.name === 'send_email')!;
    const schema = getActionInputJsonSchema(action);
    expect(schema['type']).toBe('object');
    const properties = schema['properties'] as Record<string, unknown>;
    expect(properties['to']).toBeDefined();
    expect(properties['subject']).toBeDefined();
    expect(properties['body']).toBeDefined();
  });
});

describe('mcp-transport/Action to Tool Mapping', () => {
  it('Scenario: Auto-registration', () => {
    const tools = actionsToMcpTools(testActions);

    // Adding an action auto-exposes as MCP tool
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toContain('list_emails');
    expect(tools.map(t => t.name)).toContain('send_email');
  });
});

describe('mcp-transport/stdio Transport', () => {
  it('Scenario: MCP handshake', async () => {
    // The server maps actions to tools — verify tool dispatch works
    const result = await handleToolCall(testActions, {}, 'list_emails', { unread: true });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.emails).toBeDefined();
  });

  it('Scenario: download_attachment emits typed resource content alongside text metadata', async () => {
    // Bytes go in a `resource` content item (typed binary), not stuffed inside
    // the text JSON envelope. The text item still carries metadata so clients
    // that only parse text still get filename/size/mimeType.
    const PAYLOAD = Buffer.from('hello attachment bytes');
    const downloadActions: EmailActionDef[] = [
      {
        name: 'download_attachment',
        description: 'Download',
        input: z.object({
          message_id: z.string(),
          attachment_id: z.string(),
          mailbox: z.string().optional(),
          max_size_mb: z.number().optional(),
        }),
        output: z.object({
          success: z.boolean(),
          base64: z.string().optional(),
          mimeType: z.string().optional(),
          filename: z.string().optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async () => ({
          success: true,
          base64: PAYLOAD.toString('base64'),
          mimeType: 'application/pdf',
          filename: 'note.pdf',
          original_filename: 'note.pdf',
          size: PAYLOAD.length,
        }),
      },
    ];

    const result = await handleToolCall(downloadActions, {}, 'download_attachment', {
      mailbox: 'work',
      message_id: 'msg-1',
      attachment_id: 'att-1',
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.type).toBe('text');
    const metadata = JSON.parse((result.content[0] as { text: string }).text);
    expect(metadata).not.toHaveProperty('base64');
    expect(metadata.filename).toBe('note.pdf');
    expect(metadata.mimeType).toBe('application/pdf');

    expect(result.content[1]!.type).toBe('resource');
    const resourceContent = result.content[1] as { resource: { uri: string; mimeType?: string; blob?: string } };
    expect(resourceContent.resource.mimeType).toBe('application/pdf');
    expect(resourceContent.resource.uri).toBe('attachment://work/msg-1/att-1');
    expect(Buffer.from(resourceContent.resource.blob!, 'base64').equals(PAYLOAD)).toBe(true);
  });

  it('Scenario: download_attachment failure case still uses single text envelope', async () => {
    const downloadActions: EmailActionDef[] = [
      {
        name: 'download_attachment',
        description: 'Download',
        input: z.object({ message_id: z.string(), attachment_id: z.string() }),
        output: z.object({ success: z.boolean() }),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async () => ({
          success: false,
          error: { code: 'NOT_SUPPORTED', message: 'no go', recoverable: false },
        }),
      },
    ];

    const result = await handleToolCall(downloadActions, {}, 'download_attachment', {
      message_id: 'msg-1',
      attachment_id: 'att-1',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
  });
});

describe('mcp-transport/Zod Schema Constraints', () => {
  it('Scenario: Schema compatibility', () => {
    const tools = actionsToMcpTools(testActions);

    // All tool input schemas are valid JSON Schema objects
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe('object');
      // Should have 'type' and 'properties' for object schemas
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('Scenario: root $schema is omitted for OpenClaw compatibility', () => {
    const tools = actionsToMcpTools(testActions);

    for (const tool of tools) {
      expect(tool.inputSchema.$schema).toBeUndefined();
    }
  });

  it('Scenario: ZodUnion fields emit anyOf, not {}', () => {
    // Regression lock for the `z.toJsonSchema` casing bug: previously the
    // feature-detect fell through to a hand-rolled generator that returned
    // `{}` for ZodUnion, so `send_email.to` (a string | string[] union)
    // emitted an empty object in tools/list and some MCP clients couldn't
    // validate calls. z.toJSONSchema handles unions natively.
    const unionAction: EmailActionDef[] = [
      {
        name: 'send_like',
        description: 'Schema shape mirrors send_email.to',
        input: z.object({
          to: z.string().or(z.array(z.string())).optional(),
          subject: z.string().optional(),
        }),
        output: z.object({ success: z.boolean() }),
        annotations: { readOnlyHint: false, destructiveHint: false },
        run: async () => ({ success: true }),
      },
    ];
    const [tool] = actionsToMcpTools(unionAction);
    const props = (tool!.inputSchema.properties as Record<string, unknown>);
    const toSchema = props.to as { anyOf?: Array<{ type: string }> };
    expect(toSchema.anyOf).toBeDefined();
    expect(toSchema.anyOf).toHaveLength(2);
    expect(toSchema.anyOf?.[0]?.type).toBe('string');
    expect(toSchema.anyOf?.[1]?.type).toBe('array');
    // Explicitly NOT `{}` — this is the assertion that would have caught the bug.
    expect(Object.keys(toSchema)).not.toEqual([]);
  });

  it('Scenario: defaults are exposed in tool input schema (io: input)', () => {
    // z.toJSONSchema with io:'input' emits `default` so clients know what
    // value they get if they omit the field. Backwards-compatible with the
    // old hand-rolled generator (which dropped defaults entirely) — this
    // test documents the intentional enrichment.
    const action: EmailActionDef[] = [
      {
        name: 'test_defaults',
        description: 'Exercises default exposure',
        input: z.object({
          flagged: z.boolean().default(true),
          limit: z.number().default(25),
        }),
        output: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async () => ({}),
      },
    ];
    const [tool] = actionsToMcpTools(action);
    const props = (tool!.inputSchema.properties as Record<string, { default?: unknown; type?: string }>);
    expect(props.flagged?.default).toBe(true);
    expect(props.flagged?.type).toBe('boolean');
    expect(props.limit?.default).toBe(25);
    expect(props.limit?.type).toBe('number');
    // Defaults make fields optional — not in required[].
    const required = (tool!.inputSchema.required as string[] | undefined) ?? [];
    expect(required).not.toContain('flagged');
    expect(required).not.toContain('limit');
  });
});

describe('mcp-transport/Tool Annotations', () => {
  it('Scenario: Read action annotations', () => {
    const tools = actionsToMcpTools(testActions);
    const listTool = tools.find(t => t.name === 'list_emails');

    expect(listTool!.annotations!.readOnlyHint).toBe(true);
    expect(listTool!.annotations!.destructiveHint).toBe(false);
  });
});

describe('mcp-transport/Server Discovery', () => {
  it('Scenario: server.json content', () => {
    const manifest = getServerManifest();

    expect(manifest.name).toBe('email-agent-mcp');
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.transport).toBeDefined();
    const transport = manifest.transport as { type: string; command: string; args: string[] };
    expect(transport.type).toBe('stdio');
    expect(transport.command).toBe('npx');
  });
});

// ---------------------------------------------------------------------------
// Lazy provider state — tests for the instant-connect + deferred-auth refactor.
// These exercise the seam that lets the MCP handshake complete without waiting
// on OAuth token refresh.
// ---------------------------------------------------------------------------

describe('mcp-transport/Lazy Provider State', () => {
  const noAllowlist = () => undefined;

  it('Scenario: buildLazyActions registers all tool schemas without auth', async () => {
    const state = createLazyProviderState();
    // No init has been triggered — state is still 'pending'.
    const actions = await buildLazyActions(state, noAllowlist);

    // 4 custom tools + 13 email-core actions = 17 tools, no auth performed.
    expect(actions.length).toBe(17);
    expect(state.status).toBe('pending');
    expect(state.initPromise).toBeNull();
    expect(state.provider).toBeNull();

    const tools = actionsToMcpTools(actions);
    expect(tools.map(t => t.name)).toContain('list_emails');
    expect(tools.map(t => t.name)).toContain('get_mailbox_status');
    expect(tools.map(t => t.name)).toContain('list_attachments');
    expect(tools.map(t => t.name)).toContain('download_attachment');
    expect(tools.map(t => t.name)).toContain('send_email');
  });

  it('Scenario: get_mailbox_status is non-blocking during pending/connecting', async () => {
    const state = createLazyProviderState();
    const actions = await buildLazyActions(state, noAllowlist);
    const status = actions.find(a => a.name === 'get_mailbox_status')!;

    // 'pending' — init has not been triggered yet. get_mailbox_status must
    // return immediately without awaiting ensureProvider.
    const pendingResult = await status.run({}, {}) as { status: string; warnings: string[] };
    expect(pendingResult.status).toBe('connecting');
    expect(state.status).toBe('pending'); // Still pending — didn't trigger init.
    expect(pendingResult.warnings[0]).toMatch(/warming up|Authenticating/i);
  });

  it('Scenario: concurrent ensureProvider calls share a single initPromise', async () => {
    const state = createLazyProviderState();

    // Inject a slow fake init by monkey-patching initPromise before ensureProvider runs.
    let resolveInit!: () => void;
    let initRuns = 0;
    state.initPromise = new Promise<void>(resolve => {
      resolveInit = () => {
        initRuns++;
        state.provider = {} as never; // pretend we connected
        state.status = 'connected';
        resolve();
      };
    });
    state.status = 'connecting';

    const callA = ensureProvider(state);
    const callB = ensureProvider(state);
    const callC = ensureProvider(state);

    // None have resolved yet — init is still pending.
    expect(initRuns).toBe(0);
    resolveInit();
    await Promise.all([callA, callB, callC]);

    // Exactly one init ran, and all three callers succeeded.
    expect(initRuns).toBe(1);
    expect(state.status).toBe('connected');
  });

  it('Scenario: ensureProvider throws after a failed init (fail-closed, session-sticky)', async () => {
    const state = createLazyProviderState();
    state.status = 'error';
    state.isDemo = true;
    state.error = 'All configured mailboxes failed to authenticate';
    // initPromise was already awaited and resolved (init ran and stored the error).
    state.initPromise = Promise.resolve();

    await expect(ensureProvider(state)).rejects.toThrow(/All configured mailboxes/);

    // A second call must not retry — session stickiness.
    await expect(ensureProvider(state)).rejects.toThrow(/All configured mailboxes/);
  });

  it('Scenario: email-core wrapped action returns structured error on init failure', async () => {
    const state = createLazyProviderState();
    // Simulate: init has run, all mailboxes failed.
    state.status = 'error';
    state.isDemo = true;
    state.error = 'All configured mailboxes failed to authenticate';
    state.initPromise = Promise.resolve();

    const actions = await buildLazyActions(state, noAllowlist);
    const sendEmail = actions.find(a => a.name === 'send_email')!;

    // Must NOT throw — must return the structured error shape.
    const result = await sendEmail.run({}, {
      to: ['x@example.com'],
      subject: 'test',
      body: 'test',
    }) as { success: boolean; error?: { code: string; message: string; recoverable: boolean } };

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error?.message).toMatch(/All configured mailboxes/);
    expect(result.error?.recoverable).toBe(false);
  });

  it('Scenario: custom tools fall back to demo responses in demo mode', async () => {
    const state = createLazyProviderState();
    // Simulate: no mailboxes were configured.
    state.status = 'not_configured';
    state.isDemo = true;
    state.initPromise = Promise.resolve();

    const actions = await buildLazyActions(state, noAllowlist);

    const listEmails = actions.find(a => a.name === 'list_emails')!;
    const listResult = await listEmails.run({}, {}) as { emails: Array<{ id: string; subject: string }> };
    expect(listResult.emails).toHaveLength(1);
    expect(listResult.emails[0]!.subject).toMatch(/Demo mode/);

    const readEmail = actions.find(a => a.name === 'read_email')!;
    const readResult = await readEmail.run({}, { id: 'demo-1' }) as { subject: string; body: string };
    expect(readResult.subject).toMatch(/Demo mode/);
    expect(readResult.body).toMatch(/No mailbox configured/);

    const searchEmails = actions.find(a => a.name === 'search_emails')!;
    const searchResult = await searchEmails.run({}, { query: 'anything' }) as { emails: unknown[] };
    expect(searchResult.emails).toEqual([]);

    const status = actions.find(a => a.name === 'get_mailbox_status')!;
    const statusResult = await status.run({}, {}) as { status: string; warnings: string[] };
    expect(statusResult.status).toBe('not configured');
    expect(statusResult.warnings[0]).toMatch(/No mailbox configured/);
  });

  it('Scenario: get_mailbox_status reports error state when init failed', async () => {
    const state = createLazyProviderState();
    state.status = 'error';
    state.isDemo = true;
    state.error = 'Could not load provider: missing credentials';
    state.initPromise = Promise.resolve();

    const actions = await buildLazyActions(state, noAllowlist);
    const status = actions.find(a => a.name === 'get_mailbox_status')!;
    const result = await status.run({}, {}) as { status: string; warnings: string[] };

    expect(result.status).toBe('error');
    expect(result.warnings[0]).toMatch(/missing credentials/);
  });

  it('Scenario: get_mailbox_status returns the requested failed Gmail mailbox when all auth attempts failed', async () => {
    const state = createLazyProviderState();
    state.status = 'error';
    state.isDemo = true;
    state.error = 'All configured mailboxes failed to authenticate';
    state.initPromise = Promise.resolve();
    state.mailboxes = [
      {
        name: 'personal',
        emailAddress: 'steven.obiajulu@gmail.com',
        displayName: 'steven.obiajulu@gmail.com',
        providerType: 'gmail',
        provider: null,
        auth: null,
        isDefault: false,
        status: 'error',
        error: 'Authentication expired for Gmail mailbox "steven.obiajulu@gmail.com". Run: email-agent-mcp configure --provider gmail --mailbox steven.obiajulu@gmail.com',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const status = actions.find(a => a.name === 'get_mailbox_status')!;
    const result = await status.run({}, { mailbox: 'personal' }) as {
      name: string;
      provider: string;
      status: string;
      warnings: string[];
    };

    expect(result.name).toBe('steven.obiajulu@gmail.com');
    expect(result.provider).toBe('gmail');
    expect(result.status).toBe('error');
    expect(result.warnings[0]).toContain('configure --provider gmail --mailbox steven.obiajulu@gmail.com');
  });

  it('Scenario: get_mailbox_status returns the only failed mailbox by default when all auth attempts failed', async () => {
    const state = createLazyProviderState();
    state.status = 'error';
    state.isDemo = true;
    state.error = 'Authentication expired for Gmail mailbox "steven.obiajulu@gmail.com". Run: email-agent-mcp configure --provider gmail --mailbox steven.obiajulu@gmail.com';
    state.initPromise = Promise.resolve();
    state.mailboxes = [
      {
        name: 'personal',
        emailAddress: 'steven.obiajulu@gmail.com',
        displayName: 'steven.obiajulu@gmail.com',
        providerType: 'gmail',
        provider: null,
        auth: null,
        isDefault: false,
        status: 'error',
        error: 'Authentication expired for Gmail mailbox "steven.obiajulu@gmail.com". Run: email-agent-mcp configure --provider gmail --mailbox steven.obiajulu@gmail.com',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const status = actions.find(a => a.name === 'get_mailbox_status')!;
    const result = await status.run({}, {}) as {
      name: string;
      provider: string;
      status: string;
      warnings: string[];
    };

    expect(result.name).toBe('steven.obiajulu@gmail.com');
    expect(result.provider).toBe('gmail');
    expect(result.status).toBe('error');
    expect(result.warnings[0]).toContain('configure --provider gmail --mailbox steven.obiajulu@gmail.com');
  });

  it('Scenario: get_mailbox_status reports the connected Gmail provider', async () => {
    const state = createLazyProviderState();
    state.status = 'connected';
    state.provider = {} as never;
    state.connectedMailbox = 'steven.obiajulu@gmail.com';
    state.connectedProvider = 'gmail';
    state.initPromise = Promise.resolve();

    const actions = await buildLazyActions(state, noAllowlist);
    const status = actions.find(a => a.name === 'get_mailbox_status')!;
    const result = await status.run({}, {}) as { provider: string; name: string; status: string };

    expect(result.provider).toBe('gmail');
    expect(result.name).toBe('steven.obiajulu@gmail.com');
    expect(result.status).toBe('connected');
  });

  it('Scenario: custom search_emails routes to the requested mailbox provider', async () => {
    const workSearch = vi.fn().mockResolvedValue([
      {
        id: 'work-1',
        subject: 'Work result',
        from: { email: 'boss@example.com' },
        receivedAt: '2026-04-09T10:00:00.000Z',
        isRead: false,
        hasAttachments: false,
        conversationId: 'graph-conversation-abc',
      },
    ]);
    const personalSearch = vi.fn().mockResolvedValue([
      {
        id: 'personal-1',
        subject: 'Personal result',
        from: { email: 'friend@example.com' },
        receivedAt: '2026-04-09T11:00:00.000Z',
        isRead: true,
        hasAttachments: true,
        threadId: 'gmail-thread-xyz',
      },
    ]);

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { searchMessages: workSearch } as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: { searchMessages: workSearch } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: { searchMessages: personalSearch } as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const search = actions.find(a => a.name === 'search_emails')!;
    const result = await search.run({}, { query: 'license', mailbox: 'personal' }) as {
      emails: Array<{ id: string; subject: string; mailbox?: string }>;
    };

    expect(personalSearch).toHaveBeenCalledWith('license', undefined, 25, undefined);
    expect(workSearch).not.toHaveBeenCalled();
    expect(result.emails).toEqual([
      {
        id: 'personal-1',
        subject: 'Personal result',
        from: 'friend@example.com',
        receivedAt: '2026-04-09T11:00:00.000Z',
        isRead: true,
        hasAttachments: true,
        mailbox: 'personal',
        threadId: 'gmail-thread-xyz',
      },
    ]);
  });

  it('Scenario: custom search_emails can fan out across all connected mailboxes', async () => {
    const workSearch = vi.fn().mockResolvedValue([
      {
        id: 'work-1',
        subject: 'Work result',
        from: { email: 'boss@example.com' },
        receivedAt: '2026-04-09T10:00:00.000Z',
        isRead: false,
        hasAttachments: false,
        conversationId: 'graph-conversation-abc',
      },
    ]);
    const personalSearch = vi.fn().mockResolvedValue([
      {
        id: 'personal-1',
        subject: 'Personal result',
        from: { email: 'friend@example.com' },
        receivedAt: '2026-04-09T11:00:00.000Z',
        isRead: true,
        hasAttachments: true,
        threadId: 'gmail-thread-xyz',
      },
    ]);

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { searchMessages: workSearch } as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: { searchMessages: workSearch } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: { searchMessages: personalSearch } as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const search = actions.find(a => a.name === 'search_emails')!;
    const result = await search.run({}, { query: 'license', mailbox: null, limit: 10 }) as {
      emails: Array<{ id: string; mailbox?: string }>;
    };

    expect(workSearch).toHaveBeenCalledWith('license', undefined);
    expect(personalSearch).toHaveBeenCalledWith('license', undefined);
    expect(result.emails).toEqual([
      {
        id: 'personal-1',
        subject: 'Personal result',
        from: 'friend@example.com',
        receivedAt: '2026-04-09T11:00:00.000Z',
        isRead: true,
        hasAttachments: true,
        mailbox: 'personal',
        threadId: 'gmail-thread-xyz',
      },
      {
        id: 'work-1',
        subject: 'Work result',
        from: 'boss@example.com',
        receivedAt: '2026-04-09T10:00:00.000Z',
        isRead: false,
        hasAttachments: false,
        mailbox: 'work',
        conversationId: 'graph-conversation-abc',
      },
    ]);
  });

  it('Scenario: custom read_email surfaces attachment metadata from the provider', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      id: 'msg-attachment',
      subject: 'Attachment message',
      from: { email: 'sender@example.com', name: 'Sender' },
      to: [{ email: 'recipient@example.com', name: 'Recipient' }],
      receivedAt: '2026-04-09T12:00:00.000Z',
      bodyHtml: '<p>See attached</p>',
      attachments: [
        {
          id: 'att-1',
          filename: 'license.jpeg',
          mimeType: 'image/jpeg',
          size: 692702,
          isInline: false,
        },
      ],
    });

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { getMessage } as never;
    state.connectedMailbox = 'personal@example.com';
    state.connectedProvider = 'gmail';
    state.mailboxes = [
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: { getMessage } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const readEmail = actions.find(a => a.name === 'read_email')!;
    const result = await readEmail.run({}, { id: 'msg-attachment' }) as {
      body: string;
      attachments?: Array<{ filename: string; mimeType: string; size: number }>;
    };

    expect(result.body).toContain('See attached');
    expect(result.attachments).toEqual([
      {
        id: 'att-1',
        filename: 'license.jpeg',
        mimeType: 'image/jpeg',
        size: 692702,
        contentId: undefined,
        isInline: false,
      },
    ]);
  });

  it('Scenario: read_email omits cc field even when provider returns it (wire-shape parity with pre-PR MCP tool)', async () => {
    // The pre-PR hand-rolled MCP `read_email` did not surface `cc`. The refactor delegates
    // to readEmailAction (which returns `cc`), but the MCP adapter must drop it so the wire
    // shape stays unchanged. Adding cc to the MCP surface is a separate, additive change.
    const getMessage = vi.fn().mockResolvedValue({
      id: 'msg-cc',
      subject: 'Has cc',
      from: { email: 'alice@corp.com', name: 'Alice' },
      to: [{ email: 'bob@corp.com', name: 'Bob' }],
      cc: [{ email: 'carol@corp.com', name: 'Carol' }],
      receivedAt: '2026-04-09T12:00:00.000Z',
      body: 'Hello.',
    });

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { getMessage } as never;
    state.connectedMailbox = 'alice@corp.com';
    state.mailboxes = [
      {
        name: 'alice',
        emailAddress: 'alice@corp.com',
        displayName: 'alice@corp.com',
        providerType: 'gmail',
        provider: { getMessage } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const readEmail = actions.find(a => a.name === 'read_email')!;
    const result = await readEmail.run({}, { id: 'msg-cc' }) as Record<string, unknown>;

    expect(result).not.toHaveProperty('cc');
    expect(result.id).toBe('msg-cc');
    expect(result.to).toEqual(['Bob <bob@corp.com>']);
    // The action's full schema includes cc; the MCP output schema does NOT.
    const schema = readEmail.output as { shape?: Record<string, unknown> };
    expect(schema.shape).toBeDefined();
    expect(schema.shape!.cc).toBeUndefined();
  });

  it('Scenario: read_email exposes strip_quoted_history with default false', async () => {
    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { getMessage: vi.fn() } as never;
    state.connectedMailbox = 'work@example.com';
    state.mailboxes = [];

    const actions = await buildLazyActions(state, noAllowlist);
    const readEmail = actions.find(a => a.name === 'read_email')!;

    const schema = readEmail.input as { shape?: Record<string, unknown> };
    expect(schema.shape).toBeDefined();
    expect(schema.shape!.strip_quoted_history).toBeDefined();

    const parsed = (readEmail.input as { parse: (v: unknown) => Record<string, unknown> }).parse({ id: 'msg1' });
    expect(parsed.strip_quoted_history).toBe(false);
  });

  it('Scenario: read_email with strip_quoted_history=true delegates to action and strips quoted reply', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      id: 'msg-quoted',
      subject: 'Re: Standup',
      from: { email: 'alice@corp.com', name: 'Alice' },
      to: [{ email: 'bob@corp.com', name: 'Bob' }],
      receivedAt: '2026-04-09T12:00:00.000Z',
      body: [
        'Sounds good.',
        '',
        'On Wed, Mar 13, 2024 at 9:30 AM Bob <bob@corp.com> wrote:',
        '> Want to push standup to 10am?',
      ].join('\n'),
    });

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { getMessage } as never;
    state.connectedMailbox = 'alice@corp.com';
    state.mailboxes = [
      {
        name: 'alice',
        emailAddress: 'alice@corp.com',
        displayName: 'alice@corp.com',
        providerType: 'gmail',
        provider: { getMessage } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const readEmail = actions.find(a => a.name === 'read_email')!;
    const result = await readEmail.run({}, { id: 'msg-quoted', strip_quoted_history: true }) as { body: string };

    expect(result.body).toContain('Sounds good.');
    expect(result.body).toContain('[...prior thread truncated]');
    expect(result.body).not.toContain('Want to push standup to 10am?');
  });

  it('Scenario: read_email does NOT strip signatures even with sig delimiter present', async () => {
    // Wiring strip_signatures through the MCP tool is out of scope for issue #76 and
    // tracked separately. The MCP adapter must keep the previous behavior of returning
    // signatures intact regardless of the action default.
    const getMessage = vi.fn().mockResolvedValue({
      id: 'msg-sig',
      subject: 'Signed reply',
      from: { email: 'alice@corp.com', name: 'Alice' },
      to: [{ email: 'bob@corp.com', name: 'Bob' }],
      receivedAt: '2026-04-09T12:00:00.000Z',
      body: [
        'Sounds good.',
        '',
        '-- ',
        'Alice Smith',
        'Senior Partner',
      ].join('\n'),
    });

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { getMessage } as never;
    state.connectedMailbox = 'alice@corp.com';
    state.mailboxes = [
      {
        name: 'alice',
        emailAddress: 'alice@corp.com',
        displayName: 'alice@corp.com',
        providerType: 'gmail',
        provider: { getMessage } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const readEmail = actions.find(a => a.name === 'read_email')!;
    const result = await readEmail.run({}, { id: 'msg-sig' }) as { body: string };

    expect(result.body).toContain('Alice Smith');
    expect(result.body).toContain('Senior Partner');
  });

  it('Scenario: read_email demo path is unchanged when no mailbox is configured', async () => {
    const state = createLazyProviderState();
    state.status = 'configuring';
    state.initPromise = Promise.resolve();

    const actions = await buildLazyActions(state, noAllowlist);
    const readEmail = actions.find(a => a.name === 'read_email')!;

    const result = await readEmail.run({}, { id: 'demo-1' }) as { id: string; body: string };
    expect(result.id).toBe('demo-1');
    expect(result.body).toContain('No mailbox configured');
  });

  it('Scenario: get_mailbox_status resolves the requested mailbox instead of the default', async () => {
    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = {} as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: {} as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: {} as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const status = actions.find(a => a.name === 'get_mailbox_status')!;
    const result = await status.run({}, { mailbox: 'personal@example.com' }) as {
      provider: string;
      name: string;
      status: string;
      isDefault: boolean;
    };

    expect(result.provider).toBe('gmail');
    expect(result.name).toBe('personal@example.com');
    expect(result.status).toBe('connected');
    expect(result.isDefault).toBe(false);
  });

  it('Scenario: get_mailbox_status reports a useful error for unknown requested mailboxes', async () => {
    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = {} as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: {} as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: {} as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const status = actions.find(a => a.name === 'get_mailbox_status')!;
    const result = await status.run({}, { mailbox: 'unknown@example.com' }) as {
      name: string;
      status: string;
      warnings: string[];
    };

    expect(result.name).toBe('unknown@example.com');
    expect(result.status).toBe('error');
    expect(result.warnings[0]).toContain('Available mailboxes: work@example.com, personal@example.com');
  });

  it('Scenario: custom list_emails routes to the requested mailbox provider', async () => {
    const workList = vi.fn().mockResolvedValue([]);
    const personalList = vi.fn().mockResolvedValue([
      {
        id: 'personal-1',
        subject: 'Personal result',
        from: { email: 'friend@example.com' },
        receivedAt: '2026-04-09T11:00:00.000Z',
        isRead: true,
        hasAttachments: true,
      },
    ]);

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { listMessages: workList } as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: { listMessages: workList } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: { listMessages: personalList } as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const listEmails = actions.find(a => a.name === 'list_emails')!;
    const result = await listEmails.run({}, { mailbox: 'personal', limit: 10, unread: true, folder: 'inbox' }) as {
      emails: Array<{ id: string; subject: string }>;
    };

    expect(personalList).toHaveBeenCalledWith({
      unread: true,
      limit: 10,
      offset: undefined,
      folder: 'inbox',
    });
    expect(workList).not.toHaveBeenCalled();
    expect(result.emails).toEqual([
      {
        id: 'personal-1',
        subject: 'Personal result',
        from: 'friend@example.com',
        receivedAt: '2026-04-09T11:00:00.000Z',
        isRead: true,
        hasAttachments: true,
      },
    ]);
  });

  it('Scenario: wrapped send_email uses the requested mailbox provider', async () => {
    const workCreateDraft = vi.fn().mockResolvedValue({ success: true, draftId: 'draft-work' });
    const personalCreateDraft = vi.fn().mockResolvedValue({ success: true, draftId: 'draft-personal' });

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { createDraft: workCreateDraft } as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: { createDraft: workCreateDraft } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: { createDraft: personalCreateDraft } as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const sendEmail = actions.find(a => a.name === 'send_email')!;
    const result = await sendEmail.run({}, {
      mailbox: 'personal',
      to: ['friend@example.com'],
      subject: 'hello',
      body: 'test body',
      draft: true,
    }) as { success: boolean; draftId?: string };

    expect(result).toEqual({ success: true, draftId: 'draft-personal', error: undefined });
    expect(personalCreateDraft).toHaveBeenCalledOnce();
    expect(workCreateDraft).not.toHaveBeenCalled();
  });

  it('Scenario: list_attachments uses the requested mailbox provider context', async () => {
    const workGetMessage = vi.fn().mockResolvedValue({ attachments: [] });
    const personalGetMessage = vi.fn().mockResolvedValue({
      attachments: [
        {
          id: 'att-1',
          filename: 'license.jpeg',
          mimeType: 'image/jpeg',
          size: 692702,
          isInline: false,
        },
      ],
    });

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { getMessage: workGetMessage } as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: { getMessage: workGetMessage } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: { getMessage: personalGetMessage } as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const listAttachments = actions.find(a => a.name === 'list_attachments')!;
    const result = await listAttachments.run({}, {
      mailbox: 'personal',
      message_id: 'msg-attachment',
    }) as { attachments: Array<{ filename: string }> };

    expect(personalGetMessage).toHaveBeenCalledWith('msg-attachment');
    expect(workGetMessage).not.toHaveBeenCalled();
    expect(result.attachments).toEqual([
      {
        id: 'att-1',
        filename: 'license.jpeg',
        original_filename: 'license.jpeg',
        mimeType: 'image/jpeg',
        size: 692702,
        contentId: undefined,
        isInline: false,
      },
    ]);
  });

  it('Scenario: download_attachment uses the requested mailbox provider context', async () => {
    const PAYLOAD = Buffer.from('hello attachment');
    const workListAttachments = vi.fn().mockResolvedValue([]);
    const workDownloadAttachment = vi.fn();
    const personalListAttachments = vi.fn().mockResolvedValue([
      { id: 'att-1', filename: 'note.txt', mimeType: 'text/plain', size: PAYLOAD.length, isInline: false },
    ]);
    const personalDownloadAttachment = vi.fn().mockResolvedValue({
      content: PAYLOAD,
      filename: 'note.txt',
      mimeType: 'text/plain',
      size: PAYLOAD.length,
    });

    const state = createLazyProviderState();
    state.status = 'connected';
    state.initPromise = Promise.resolve();
    state.provider = { listAttachments: workListAttachments, downloadAttachment: workDownloadAttachment } as never;
    state.connectedMailbox = 'work@example.com';
    state.connectedProvider = 'microsoft';
    state.mailboxes = [
      {
        name: 'work',
        emailAddress: 'work@example.com',
        displayName: 'work@example.com',
        providerType: 'microsoft',
        provider: { listAttachments: workListAttachments, downloadAttachment: workDownloadAttachment } as never,
        auth: null,
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'personal',
        emailAddress: 'personal@example.com',
        displayName: 'personal@example.com',
        providerType: 'gmail',
        provider: { listAttachments: personalListAttachments, downloadAttachment: personalDownloadAttachment } as never,
        auth: null,
        isDefault: false,
        status: 'connected',
      },
    ];

    const actions = await buildLazyActions(state, noAllowlist);
    const downloadAttachment = actions.find(a => a.name === 'download_attachment')!;
    const result = await downloadAttachment.run({}, {
      mailbox: 'personal',
      message_id: 'msg-1',
      attachment_id: 'att-1',
      max_size_mb: 5,
    }) as { success: boolean; base64?: string };

    expect(personalDownloadAttachment).toHaveBeenCalledWith('msg-1', 'att-1');
    expect(workDownloadAttachment).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(Buffer.from(result.base64!, 'base64').equals(PAYLOAD)).toBe(true);
  });

  it('Scenario: download_attachment returns PROVIDER_UNAVAILABLE when init failed', async () => {
    const state = createLazyProviderState();
    state.status = 'error';
    state.isDemo = true;
    state.error = 'All configured mailboxes failed to authenticate';
    state.initPromise = Promise.resolve();

    const actions = await buildLazyActions(state, noAllowlist);
    const downloadAttachment = actions.find(a => a.name === 'download_attachment')!;
    const result = await downloadAttachment.run({}, {
      message_id: 'msg-1',
      attachment_id: 'att-1',
      max_size_mb: 5,
    }) as { success: boolean; error?: { code: string; message: string; recoverable: boolean } };

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error?.message).toMatch(/All configured mailboxes/);
  });

  it('Scenario: waitForInit returns immediately once a terminal state is reached', async () => {
    const state = createLazyProviderState();
    state.status = 'not_configured';
    state.isDemo = true;
    state.initPromise = Promise.resolve();

    // Should be a no-op — no new initPromise is created.
    const spy = vi.spyOn(state, 'initPromise' as never, 'get');
    await waitForInit(state);
    spy.mockRestore();
    expect(state.status).toBe('not_configured');
  });
});

// ---------------------------------------------------------------------------
// Scalar Coercion at MCP Boundary
//
// Claude Code's XML parameter encoder serializes boolean/number tool args as
// strings on the wire (`"true"`, `"3"`). The email-core Zod schemas are
// strict and reject strings. coerceArgsForZod walks the top-level shape and
// converts matching fields so wire-format reality stops breaking tool calls,
// without polluting the reusable email-core schemas.
// ---------------------------------------------------------------------------

describe('mcp-transport/Scalar Coercion at Boundary', () => {
  it('Scenario: boolean "true"/"false" → true/false; other strings pass through', () => {
    const schema = z.object({ flag: z.boolean().optional() });
    expect(coerceArgsForZod(schema, { flag: 'true' })).toEqual({ flag: true });
    expect(coerceArgsForZod(schema, { flag: 'false' })).toEqual({ flag: false });
    // Unknown strings are left alone — Zod will produce its normal error.
    expect(coerceArgsForZod(schema, { flag: 'yes' })).toEqual({ flag: 'yes' });
    // Already-typed values are untouched.
    expect(coerceArgsForZod(schema, { flag: true })).toEqual({ flag: true });
    expect(coerceArgsForZod(schema, { flag: false })).toEqual({ flag: false });
  });

  it('Scenario: strict decimal/float strings → numbers; exotic shapes pass through', () => {
    const schema = z.object({ limit: z.number().optional() });
    // Accepted: plain decimals, floats, zero, negatives.
    expect(coerceArgsForZod(schema, { limit: '3' })).toEqual({ limit: 3 });
    expect(coerceArgsForZod(schema, { limit: '3.14' })).toEqual({ limit: 3.14 });
    expect(coerceArgsForZod(schema, { limit: '0' })).toEqual({ limit: 0 });
    expect(coerceArgsForZod(schema, { limit: '-5' })).toEqual({ limit: -5 });
    expect(coerceArgsForZod(schema, { limit: '-3.14' })).toEqual({ limit: -3.14 });
    // Rejected (passed through as-is): Zod will throw its own invalid_type.
    // `Number()` would silently accept all of these, which is the footgun we
    // are closing off.
    expect(coerceArgsForZod(schema, { limit: 'abc' })).toEqual({ limit: 'abc' });
    expect(coerceArgsForZod(schema, { limit: '' })).toEqual({ limit: '' });
    expect(coerceArgsForZod(schema, { limit: '  3  ' })).toEqual({ limit: '  3  ' }); // whitespace
    expect(coerceArgsForZod(schema, { limit: '0x10' })).toEqual({ limit: '0x10' });   // hex
    expect(coerceArgsForZod(schema, { limit: '1e3' })).toEqual({ limit: '1e3' });     // scientific
    expect(coerceArgsForZod(schema, { limit: 'Infinity' })).toEqual({ limit: 'Infinity' });
    expect(coerceArgsForZod(schema, { limit: 'NaN' })).toEqual({ limit: 'NaN' });
    expect(coerceArgsForZod(schema, { limit: '3.' })).toEqual({ limit: '3.' });       // trailing dot
    expect(coerceArgsForZod(schema, { limit: '.5' })).toEqual({ limit: '.5' });       // leading dot
    // Already-typed numbers are untouched.
    expect(coerceArgsForZod(schema, { limit: 42 })).toEqual({ limit: 42 });
  });

  it('Scenario: .refine() wrappers preserve the inner type discriminator', () => {
    // Zod v4 does not have ZodEffects — a refined number still reports
    // type: 'number' so coercion works through .refine() without any extra
    // unwrapping logic. Lock that in.
    const schema = z.object({
      n: z.number().refine(v => v > 0, 'must be positive'),
      flag: z.boolean().refine(v => v === true, 'must be true'),
    });
    expect(coerceArgsForZod(schema, { n: '5', flag: 'true' })).toEqual({ n: 5, flag: true });
  });

  it('Scenario: .pipe()/.transform() fields are NOT descended into', () => {
    // pipe/transform can change the accepted input type, so coercing through
    // them would be ambiguous. Intentional non-goal — document by test.
    const schema = z.object({
      n: z.string().pipe(z.coerce.number()),
    });
    // 'n' is declared as `pipe`, not `number`, so we leave it alone and let
    // the downstream parser handle it.
    expect(coerceArgsForZod(schema, { n: '5' })).toEqual({ n: '5' });
  });

  it('Scenario: wrapped types (optional/default/nullable) still get coerced', () => {
    const schema = z.object({
      a: z.boolean().optional(),
      b: z.boolean().optional().default(true),
      c: z.number().nullable(),
      d: z.number().default(25),
    });
    expect(coerceArgsForZod(schema, { a: 'false', b: 'true', c: '7', d: '100' })).toEqual({
      a: false,
      b: true,
      c: 7,
      d: 100,
    });
  });

  it('Scenario: non-object args are returned unchanged (defensive)', () => {
    const schema = z.object({ flag: z.boolean() });
    expect(coerceArgsForZod(schema, null)).toBe(null);
    expect(coerceArgsForZod(schema, undefined)).toBe(undefined);
    expect(coerceArgsForZod(schema, 'string')).toBe('string');
    expect(coerceArgsForZod(schema, 42)).toBe(42);
    expect(coerceArgsForZod(schema, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('Scenario: nested object/array fields are NOT recursed into', () => {
    // Intentional: only top-level scalars. If a future action nests a boolean
    // inside an object, extend coerceArgsForZod then.
    const schema = z.object({
      filter: z.object({ unread: z.boolean() }),
      tags: z.array(z.string()),
    });
    const out = coerceArgsForZod(schema, {
      filter: { unread: 'true' },
      tags: ['a'],
    }) as { filter: { unread: unknown } };
    expect(out.filter.unread).toBe('true'); // untouched
  });

  it('Scenario: unknown fields (not declared in the schema) are untouched', () => {
    const schema = z.object({ flag: z.boolean().optional() });
    expect(coerceArgsForZod(schema, { flag: 'true', extra: 'hello' })).toEqual({
      flag: true,
      extra: 'hello',
    });
  });

  it('Scenario: handleToolCall coerces stringified scalars end-to-end', async () => {
    const echoActions: EmailActionDef[] = [
      {
        name: 'echo',
        description: 'Echo its coerced input',
        input: z.object({ flag: z.boolean(), n: z.number() }),
        output: z.object({ flag: z.boolean(), n: z.number() }),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async (_ctx, input) => input,
      },
    ];
    const result = await handleToolCall(echoActions, {}, 'echo', { flag: 'true', n: '42' });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ flag: true, n: 42 });
  });

  it('Scenario: SAFETY — real deleteEmailAction rejects stringified "false"', async () => {
    // The entire reason we do not use z.coerce.boolean() — it would turn
    // 'false' into true because JS Boolean('false') === true, silently
    // enabling destructive operations. This test wires the REAL
    // deleteEmailAction from email-core through handleToolCall so a future
    // refactor that bypasses coerceArgsForZod can't silently break the
    // safety guarantee.

    const deleteMessage = vi.fn();
    const fakeCtx = {
      provider: { deleteMessage },
      deleteEnabled: true, // bypass "deletion disabled" so we reach the auth check
    };

    // Wrap the real action as an EmailActionDef so handleToolCall can dispatch it.
    const actions: EmailActionDef[] = [
      {
        name: deleteEmailAction.name,
        description: deleteEmailAction.description,
        input: deleteEmailAction.input,
        output: deleteEmailAction.output,
        annotations: deleteEmailAction.annotations,
        run: (_ctx, input) => deleteEmailAction.run(fakeCtx as never, input as never),
      },
    ];

    const result = await handleToolCall(actions, {}, 'delete_email', {
      id: 'msg-1',
      user_explicitly_requested_deletion: 'false', // wire format — string
      hard_delete: 'false',
    });

    // Provider must NOT have been called. If 'false' had been flipped to
    // true, checkDeletePolicy would pass and deleteMessage would run.
    expect(deleteMessage).not.toHaveBeenCalled();

    // The action should return a policy error indicating the missing consent.
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toMatch(/user_explicitly_requested_deletion must be true/);
  });

  it('Scenario: SAFETY — real deleteEmailAction executes when "true" is passed', async () => {
    // Complement to the regression above: if the caller explicitly sends
    // 'true' as a string, coercion must flip it to `true` so the legitimate
    // delete path still works end-to-end.
    const deleteMessage = vi.fn();
    const fakeCtx = {
      provider: { deleteMessage },
      deleteEnabled: true,
    };

    const actions: EmailActionDef[] = [
      {
        name: deleteEmailAction.name,
        description: deleteEmailAction.description,
        input: deleteEmailAction.input,
        output: deleteEmailAction.output,
        annotations: deleteEmailAction.annotations,
        run: (_ctx, input) => deleteEmailAction.run(fakeCtx as never, input as never),
      },
    ];

    const result = await handleToolCall(actions, {}, 'delete_email', {
      id: 'msg-1',
      user_explicitly_requested_deletion: 'true',
      hard_delete: 'false',
    });

    expect(deleteMessage).toHaveBeenCalledWith('msg-1', false);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.success).toBe(true);
  });
});
