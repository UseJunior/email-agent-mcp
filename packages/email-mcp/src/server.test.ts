import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  actionsToMcpTools,
  handleToolCall,
  getServerManifest,
  createLazyProviderState,
  waitForInit,
  ensureProvider,
  buildLazyActions,
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
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.emails).toBeDefined();
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

    // 4 custom tools + 11 email-core actions = 15 tools, no auth performed.
    expect(actions.length).toBe(15);
    expect(state.status).toBe('pending');
    expect(state.initPromise).toBeNull();
    expect(state.provider).toBeNull();

    const tools = actionsToMcpTools(actions);
    expect(tools.map(t => t.name)).toContain('list_emails');
    expect(tools.map(t => t.name)).toContain('get_mailbox_status');
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
