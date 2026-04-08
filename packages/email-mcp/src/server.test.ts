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

  it('Scenario: numeric strings → numbers; invalid strings pass through', () => {
    const schema = z.object({ limit: z.number().optional() });
    expect(coerceArgsForZod(schema, { limit: '3' })).toEqual({ limit: 3 });
    expect(coerceArgsForZod(schema, { limit: '3.14' })).toEqual({ limit: 3.14 });
    expect(coerceArgsForZod(schema, { limit: '0' })).toEqual({ limit: 0 });
    // Non-numeric strings left alone — Zod will reject with its normal error.
    expect(coerceArgsForZod(schema, { limit: 'abc' })).toEqual({ limit: 'abc' });
    expect(coerceArgsForZod(schema, { limit: '' })).toEqual({ limit: '' });
    // Already-typed numbers are untouched.
    expect(coerceArgsForZod(schema, { limit: 42 })).toEqual({ limit: 42 });
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
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual({ flag: true, n: 42 });
  });

  it('Scenario: SAFETY — user_explicitly_requested_deletion: "false" stays false', async () => {
    // This is the reason we can't use z.coerce.boolean() — it turns 'false' into true
    // because JS Boolean('false') === true. For delete_email, flipping false → true
    // would silently enable destructive operations. Lock this behaviour in forever.
    const deleteSchema = z.object({
      id: z.string(),
      user_explicitly_requested_deletion: z.boolean(),
      hard_delete: z.boolean().optional().default(false),
    });

    const coerced = coerceArgsForZod(deleteSchema, {
      id: 'msg-1',
      user_explicitly_requested_deletion: 'false',
      hard_delete: 'false',
    }) as { user_explicitly_requested_deletion: boolean; hard_delete: boolean };

    expect(coerced.user_explicitly_requested_deletion).toBe(false);
    expect(coerced.hard_delete).toBe(false);

    // And end-to-end through handleToolCall: the run fn must receive false.
    const seen: Array<{ user_explicitly_requested_deletion: boolean; hard_delete: boolean }> = [];
    const deleteActions: EmailActionDef[] = [
      {
        name: 'delete_email',
        description: 'delete',
        input: deleteSchema,
        output: z.object({ success: z.boolean() }),
        annotations: { readOnlyHint: false, destructiveHint: true },
        run: async (_ctx, input) => {
          seen.push(input as never);
          return { success: false };
        },
      },
    ];
    await handleToolCall(deleteActions, {}, 'delete_email', {
      id: 'msg-1',
      user_explicitly_requested_deletion: 'false',
      hard_delete: 'false',
    });
    expect(seen[0]!.user_explicitly_requested_deletion).toBe(false);
    expect(seen[0]!.hard_delete).toBe(false);
  });
});
