// MCP server — thin transport adapter mapping action registry to MCP tools
import { createRequire } from 'node:module';
import type { EmailAction, EmailProvider } from '@usejunior/email-core';
import { z } from 'zod';

/**
 * Lazy provider state — tracks deferred init so the MCP handshake can complete
 * instantly while OAuth token refresh runs in the background.
 */
export interface LazyProviderAuth {
  getTokenHealthWarning: () => string | undefined;
  tryReconnect: () => Promise<boolean>;
}

export interface LazyProviderState {
  provider: EmailProvider | null;
  auth: LazyProviderAuth | null;
  initPromise: Promise<void> | null;
  error: string | null;
  /** True when no mailboxes are configured OR all auth attempts failed. */
  isDemo: boolean;
  status: 'pending' | 'connecting' | 'connected' | 'not_configured' | 'error';
  /** Human-readable display name of the connected mailbox, if any. */
  connectedMailbox: string | null;
}

/** Create a fresh lazy state. */
export function createLazyProviderState(): LazyProviderState {
  return {
    provider: null,
    auth: null,
    initPromise: null,
    error: null,
    isDemo: false,
    status: 'pending',
    connectedMailbox: null,
  };
}

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

// Re-export types for the action registry
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpToolCallResult {
  content: Array<{ type: string; text: string }>;
}

export interface EmailActionDef {
  name: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  run: (ctx: unknown, input: unknown) => Promise<unknown>;
}

/**
 * Generate MCP tool list from action registry.
 */
export function actionsToMcpTools(actions: EmailActionDef[]): McpTool[] {
  return actions.map(action => ({
    name: action.name,
    description: action.description,
    inputSchema: zodToJsonSchema(action.input),
    annotations: {
      readOnlyHint: action.annotations.readOnlyHint,
      destructiveHint: action.annotations.destructiveHint,
    },
  }));
}

// Strict decimal/float regex for coercing numeric strings. Rejects hex
// (`0x10`), scientific notation (`1e3`), `Infinity`, whitespace, and other
// shapes that `Number()` silently accepts but which are unlikely to be
// intended when an LLM emits a tool-call arg.
const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;

/**
 * Read the Zod v4 public type discriminator for a schema.
 *
 * Uses `.type` / `.def.type`, which are part of the stable `zod@^4` surface
 * (see `node_modules/zod/v4/classic/schemas.d.ts` — `_def` is explicitly
 * `@deprecated Use .def instead.`). Falls back through both for safety.
 */
function zodTypeId(schema: z.ZodType): string {
  const s = schema as unknown as { type?: string; def?: { type?: string } };
  return s.type ?? s.def?.type ?? '';
}

/**
 * Unwrap Optional/Default/Nullable wrappers to reach the inner scalar type.
 *
 * Zod v4 no longer has `ZodEffects`; `.refine()` preserves the underlying
 * type discriminator (a refined number still reports `type: 'number'`), and
 * `.transform()` / `.pipe()` produce a `pipe` wrapper that we deliberately
 * do not descend into — transforms can change the accepted input type and
 * coercing through them would be ambiguous. The cycle guard (max 10 hops)
 * is belt-and-suspenders; real schemas nest at most 2-3 levels.
 */
function unwrapZodType(schema: z.ZodType): z.ZodType {
  let cur: z.ZodType = schema;
  for (let i = 0; i < 10; i++) {
    const id = zodTypeId(cur);
    if (id === 'optional' || id === 'default' || id === 'nullable') {
      const inner = (cur as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
      if (!inner) return cur;
      cur = inner;
      continue;
    }
    return cur;
  }
  return cur;
}

/**
 * Coerce string-typed scalar args to their Zod-declared types at the MCP
 * adapter boundary.
 *
 * **Why this exists.** Claude Code's XML parameter encoder serializes scalar
 * MCP tool args as strings on the wire (`<parameter name="limit">3</parameter>`
 * arrives as `"3"`, not `3`). The strict `z.boolean()` / `z.number()` schemas
 * in `email-core` reject these with `invalid_type`, so every tool call with a
 * scalar arg would fail from inside a Claude Code session. The MCP spec does
 * not prescribe coercion — servers are expected to handle their own wire
 * format. We fix it at the adapter boundary so the reusable `email-core`
 * schemas stay strict for other consumers.
 *
 * **Scope.** Walks the top-level shape of an object schema only. Nested
 * objects, arrays, unions, and discriminated unions are intentionally NOT
 * recursed into:
 * - no current action has a nested boolean/number field
 * - union coercion is ambiguous (`"3"` could satisfy either branch of a
 *   `string | number` union)
 * - transforms/pipes can change the accepted input type
 *
 * If a future action introduces a nested scalar field, extend the walker
 * then — don't speculatively add complexity.
 *
 * **Boolean safety.** Explicit `'true'`/`'false'` matching, NOT
 * `z.coerce.boolean`. The latter uses JS `Boolean(v)` semantics where any
 * non-empty string is truthy, so `z.coerce.boolean().parse('false') === true`
 * — which would silently flip destructive flags like
 * `delete_email.user_explicitly_requested_deletion`. This is enforced by the
 * safety regression test in `server.test.ts`.
 *
 * **Number safety.** Uses a strict decimal/float regex (`NUMERIC_STRING`)
 * instead of `Number(v) + isFinite`. The former rejects `"0x10"`, `"1e3"`,
 * `"  3  "`, `"Infinity"`, and other shapes that `Number()` accepts but
 * which are unlikely to be intended by an LLM emitting a tool arg.
 */
export function coerceArgsForZod(schema: z.ZodType, args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const shapeRoot = unwrapZodType(schema);
  if (zodTypeId(shapeRoot) !== 'object') return args;

  // ZodObject exposes a public `.shape` accessor on the schema itself
  // (plain object, not a function) in Zod v4.
  const shape = (shapeRoot as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    const id = zodTypeId(unwrapZodType(fieldSchema));
    if (id === 'boolean') {
      if (v === 'true') out[key] = true;
      else if (v === 'false') out[key] = false;
      // else leave as string — Zod will produce its normal error
    } else if (id === 'number') {
      if (NUMERIC_STRING.test(v)) out[key] = Number(v);
      // else leave as string — Zod will reject with its normal error
    }
  }
  return out;
}

/**
 * Handle an MCP tool call by dispatching to the right action.
 */
export async function handleToolCall(
  actions: EmailActionDef[],
  ctx: unknown,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const action = actions.find(a => a.name === toolName);
  if (!action) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const coerced = coerceArgsForZod(action.input, args);
  const input = action.input.parse(coerced);
  const result = await action.run(ctx, input);

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Convert a Zod schema to JSON Schema (simplified).
 * Uses Zod v4's built-in JSON Schema generation when available.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    // Try Zod v4 built-in toJsonSchema
    if ('toJsonSchema' in z && typeof (z as unknown as { toJsonSchema: (s: z.ZodType) => Record<string, unknown> }).toJsonSchema === 'function') {
      return (z as unknown as { toJsonSchema: (s: z.ZodType) => Record<string, unknown> }).toJsonSchema(schema);
    }
  } catch {
    // Fall through to manual generation
  }

  // Manual JSON Schema generation for common patterns
  return generateJsonSchema(schema);
}

function generateJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Zod v4 uses `_def.type` as a string discriminator and `_def.shape` as a plain object
  const def = schema._def as {
    type?: string;
    typeName?: string;
    shape?: Record<string, z.ZodType> | (() => Record<string, z.ZodType>);
    innerType?: z.ZodType;
    defaultValue?: () => unknown;
  };

  const typeId = def.type ?? def.typeName ?? '';

  switch (typeId) {
    case 'string':
    case 'ZodString':
      return { type: 'string' };
    case 'number':
    case 'ZodNumber':
      return { type: 'number' };
    case 'boolean':
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'array':
    case 'ZodArray': {
      const itemType = def.innerType ?? (def as { element?: z.ZodType }).element;
      return { type: 'array', items: itemType ? generateJsonSchema(itemType) : {} };
    }
    case 'object':
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : (def.shape ?? {});
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const propDef = (value as z.ZodType)._def as { type?: string; typeName?: string };
        const propType = propDef.type ?? propDef.typeName ?? '';
        properties[key] = generateJsonSchema(value as z.ZodType);
        if (propType !== 'optional' && propType !== 'ZodOptional' &&
            propType !== 'default' && propType !== 'ZodDefault') {
          required.push(key);
        }
      }
      return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
    }
    case 'optional':
    case 'ZodOptional':
      return def.innerType ? generateJsonSchema(def.innerType) : {};
    case 'default':
    case 'ZodDefault':
      return def.innerType ? generateJsonSchema(def.innerType) : {};
    case 'nullable':
    case 'ZodNullable':
      return def.innerType ? { ...generateJsonSchema(def.innerType), nullable: true } : {};
    default:
      return {};
  }
}

/**
 * Wait for provider initialization to complete. Triggers init if not started yet.
 * NEVER throws — callers inspect `state` to decide how to respond.
 *
 * Used by custom tools (list_emails/read_email/search_emails) that need to
 * distinguish demo mode from a connected provider at call time.
 */
export async function waitForInit(state: LazyProviderState): Promise<void> {
  if (
    state.status === 'connected' ||
    state.status === 'not_configured' ||
    state.status === 'error'
  ) {
    return;
  }
  if (!state.initPromise) {
    state.status = 'connecting';
    state.initPromise = initProvider(state);
  }
  try {
    await state.initPromise;
  } catch {
    // initProvider never throws, but belt-and-suspenders for future changes.
  }
}

/**
 * Assert that a real provider is available. Throws if init failed or no
 * mailbox is configured. Used by email-core action wrappers so that tool
 * calls return a structured error in demo mode.
 */
export async function ensureProvider(state: LazyProviderState): Promise<void> {
  await waitForInit(state);
  if (!state.provider) {
    throw new Error(
      state.error ??
        'No mailbox configured — run: email-agent-mcp configure --mailbox <name> --provider microsoft',
    );
  }
}

/**
 * Background-safe provider initialization. Iterates configured mailboxes,
 * records success or failure on `state`. **Never throws** — fire-and-forget
 * callers rely on this invariant.
 */
export async function initProvider(state: LazyProviderState): Promise<void> {
  try {
    const { listConfiguredMailboxesWithMetadata, DelegatedAuthManager, RealGraphApiClient, GraphEmailProvider } =
      await import('@usejunior/provider-microsoft');
    const allMailboxes = await listConfiguredMailboxesWithMetadata();

    if (allMailboxes.length === 0) {
      state.isDemo = true;
      state.status = 'not_configured';
      console.error('[email-agent-mcp] No configured mailboxes — running in demo mode');
      console.error('[email-agent-mcp] Run: email-agent-mcp configure --mailbox <name> --provider microsoft');
      return;
    }

    for (const metadata of allMailboxes) {
      const displayName = metadata.emailAddress ?? metadata.mailboxName;
      try {
        const auth = new DelegatedAuthManager(
          { mode: 'delegated', clientId: metadata.clientId, tenantId: metadata.tenantId },
          metadata.mailboxName,
        );
        await auth.reconnect();
        const client = new RealGraphApiClient(() => auth.getAccessToken(), () => auth.tryReconnect());
        const provider = new GraphEmailProvider(client);

        state.provider = provider;
        state.auth = {
          getTokenHealthWarning: () => auth.getTokenHealthWarning(),
          tryReconnect: () => auth.tryReconnect(),
        };
        state.connectedMailbox = displayName;
        state.status = 'connected';
        console.error(`[email-agent-mcp] Connected to mailbox "${displayName}" (${metadata.clientId})`);
        return;
      } catch (err) {
        console.error(
          `[email-agent-mcp] Skipping mailbox "${displayName}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // All configured mailboxes failed to authenticate.
    state.isDemo = true;
    state.status = 'error';
    state.error = 'All configured mailboxes failed to authenticate';
    console.error(
      '[email-agent-mcp] WARNING: All configured mailboxes failed to authenticate — running in demo mode. Run: email-agent-mcp configure',
    );
  } catch (err) {
    state.isDemo = true;
    state.status = 'error';
    state.error = `Could not load provider: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[email-agent-mcp] Could not connect to real provider: ${state.error}`);
    console.error('[email-agent-mcp] Running in demo mode');
  }
}

/**
 * Build the tool registry without performing any auth. Schemas for all tools
 * are registered immediately so `tools/list` can return instantly. Tool `run`
 * callbacks lazily await `ensureProvider`/`waitForInit` on first invocation.
 */
export async function buildLazyActions(
  state: LazyProviderState,
  getSendAllowlist: () => { entries: string[] } | undefined,
): Promise<EmailActionDef[]> {
  const {
    sendEmailAction,
    replyToEmailAction,
    createDraftAction,
    sendDraftAction,
    updateDraftAction,
    getThreadAction,
    labelEmailAction,
    flagEmailAction,
    markReadAction,
    moveToFolderAction,
    deleteEmailAction,
  } = await import('@usejunior/email-core');

  // Shared context for email-core actions — provider is resolved at call time.
  const actionCtx = {
    get provider() { return state.provider as never; },
    get sendAllowlist() { return getSendAllowlist(); },
  };

  // Structured "provider unavailable" error — matches the shape of email-core errors.
  const providerUnavailableError = (err: unknown) => ({
    success: false,
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapAction = (action: EmailAction<any, any>): EmailActionDef => ({
    name: action.name,
    description: action.description,
    input: action.input,
    output: action.output,
    annotations: action.annotations,
    run: async (_ctx, input) => {
      try {
        await ensureProvider(state);
      } catch (err) {
        return providerUnavailableError(err);
      }
      return action.run(actionCtx as never, input as never);
    },
  });

  // Demo fallback responses for the 4 custom tools (preserved from buildDemoActions).
  const demoListEmails = () => ({
    emails: [
      {
        id: 'demo-1',
        subject: 'Demo mode — run email-agent-mcp configure to connect',
        from: 'system@email-agent-mcp.dev',
        receivedAt: new Date().toISOString(),
        isRead: false,
        hasAttachments: false,
      },
    ],
  });
  const demoReadEmail = (id: string) => ({
    id,
    subject: 'Demo mode',
    from: 'system@email-agent-mcp.dev',
    to: ['user@example.com'],
    body: 'No mailbox configured. Run: email-agent-mcp configure --mailbox <name> --provider microsoft',
    receivedAt: new Date().toISOString(),
  });

  return [
    {
      name: 'list_emails',
      description: 'List recent emails with filtering by unread status, folder, sender, and limit. Use offset for pagination.',
      input: z.object({ mailbox: z.string().optional(), unread: z.boolean().optional(), limit: z.number().optional(), offset: z.number().optional(), folder: z.string().optional() }),
      output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean() })) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async (_ctx, input) => {
        await waitForInit(state);
        if (!state.provider) return demoListEmails();
        const inp = input as { unread?: boolean; limit?: number; offset?: number; folder?: string };
        const messages = await state.provider.listMessages({ unread: inp.unread, limit: inp.limit ?? 25, offset: inp.offset, folder: inp.folder ?? 'inbox' });
        return {
          emails: (messages as Array<{ id: string; subject: string; from: { email: string; name?: string }; receivedAt: string; isRead: boolean; hasAttachments: boolean }>).map(m => ({
            id: m.id,
            subject: m.subject,
            from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
            receivedAt: m.receivedAt,
            isRead: m.isRead,
            hasAttachments: m.hasAttachments,
          })),
        };
      },
    },
    {
      name: 'read_email',
      description: 'Read the full content of an email by ID, transformed to token-efficient markdown',
      input: z.object({ id: z.string(), mailbox: z.string().optional() }),
      output: z.object({ id: z.string(), subject: z.string(), from: z.string(), to: z.array(z.string()), body: z.string(), receivedAt: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async (_ctx, input) => {
        await waitForInit(state);
        const inp = input as { id: string };
        if (!state.provider) return demoReadEmail(inp.id);
        const msg = await state.provider.getMessage(inp.id) as { id: string; subject: string; from: { email: string; name?: string }; to: Array<{ email: string; name?: string }>; receivedAt: string; body?: string; bodyHtml?: string };

        let emailBody = '';
        if (msg.bodyHtml) {
          try {
            const { htmlToMarkdown } = await import('@usejunior/email-core');
            emailBody = htmlToMarkdown(msg.bodyHtml);
          } catch {
            emailBody = msg.bodyHtml;
          }
        } else if (msg.body) {
          emailBody = msg.body;
        }

        return {
          id: msg.id,
          subject: msg.subject,
          from: msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email,
          to: msg.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email),
          body: emailBody,
          receivedAt: msg.receivedAt,
        };
      },
    },
    {
      name: 'search_emails',
      description: 'Search emails using full-text query across one or all mailboxes. Use offset for pagination.',
      input: z.object({ query: z.string(), mailbox: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() }),
      output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean() })) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async (_ctx, input) => {
        await waitForInit(state);
        if (!state.provider) return { emails: [] };
        const inp = input as { query: string; limit?: number; offset?: number };
        const results = await state.provider.searchMessages(inp.query, undefined, inp.limit, inp.offset) as Array<{ id: string; subject: string; from: { email: string; name?: string }; receivedAt: string; isRead: boolean; hasAttachments: boolean }>;
        return {
          emails: results.map(m => ({
            id: m.id,
            subject: m.subject,
            from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
            receivedAt: m.receivedAt,
            isRead: m.isRead,
            hasAttachments: m.hasAttachments,
          })),
        };
      },
    },
    {
      name: 'get_mailbox_status',
      description: 'Get mailbox connection status, unread count, and warnings',
      input: z.object({ mailbox: z.string().optional() }),
      output: z.object({ name: z.string(), provider: z.string(), status: z.string(), isDefault: z.boolean(), warnings: z.array(z.string()) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      // NON-BLOCKING — reports state directly without awaiting ensureProvider.
      // This is how callers check whether the server is still warming up.
      run: async () => {
        const warnings: string[] = [];
        switch (state.status) {
          case 'pending':
          case 'connecting':
            return { name: 'pending', provider: 'pending', status: 'connecting', isDefault: false, warnings: ['Authenticating — provider is warming up'] };
          case 'not_configured':
            return { name: 'none', provider: 'none', status: 'not configured', isDefault: false, warnings: ['No mailbox configured. Run: email-agent-mcp configure --mailbox <name> --provider microsoft'] };
          case 'error':
            return { name: 'none', provider: 'none', status: 'error', isDefault: false, warnings: [state.error ?? 'Provider init failed'] };
          case 'connected': {
            const healthWarning = state.auth?.getTokenHealthWarning();
            if (healthWarning) warnings.push(healthWarning);
            const currentAllowlist = getSendAllowlist();
            if (!currentAllowlist || currentAllowlist.entries.length === 0) {
              warnings.push('Send allowlist not configured — all outbound email is disabled. Run: email-agent-mcp configure');
            }
            return { name: state.connectedMailbox ?? 'default', provider: 'microsoft', status: 'connected', isDefault: true, warnings };
          }
        }
      },
    },
    wrapAction(sendEmailAction),
    wrapAction(replyToEmailAction),
    wrapAction(createDraftAction),
    wrapAction(sendDraftAction),
    wrapAction(updateDraftAction),
    wrapAction(getThreadAction),
    wrapAction(labelEmailAction),
    wrapAction(flagEmailAction),
    wrapAction(markReadAction),
    wrapAction(moveToFolderAction),
    wrapAction(deleteEmailAction),
  ];
}

/**
 * Run the MCP server on stdio. Connects the transport immediately, then kicks
 * off provider init in the background so the MCP handshake never waits on OAuth.
 */
export async function runServer(): Promise<void> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  // Load send allowlist with hot-reload (convention: ~/.email-agent-mcp/send-allowlist.json)
  const { loadSendAllowlist, getSendAllowlistPath, WatchedAllowlist } = await import('@usejunior/email-core');
  const sendAllowlistPath = getSendAllowlistPath();
  const sendAllowlistWatcher = new WatchedAllowlist(sendAllowlistPath, loadSendAllowlist);
  await sendAllowlistWatcher.start();
  const getSendAllowlist = () => sendAllowlistWatcher.config;
  if (sendAllowlistWatcher.config && sendAllowlistWatcher.config.entries.length > 0) {
    console.error(`[email-agent-mcp] Send allowlist loaded (watched): ${sendAllowlistWatcher.config.entries.length} entries from ${sendAllowlistPath}`);
  } else {
    console.error(`[email-agent-mcp] WARNING: Send allowlist empty or not found at ${sendAllowlistPath} — all outbound email is disabled`);
  }

  // Build tool registry with lazy provider state (no auth yet).
  const state = createLazyProviderState();
  const actions = await buildLazyActions(state, getSendAllowlist);

  const server = new Server(
    { name: 'email-agent-mcp', version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools = actionsToMcpTools(actions);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.setRequestHandler(CallToolRequestSchema, (async (request: any) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(actions, {}, name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }) as never);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[email-agent-mcp] MCP server started on stdio (${tools.length} tools) — provider init deferred`);

  // Fire-and-forget: warm up the provider in the background so most first tool
  // calls hit a ready provider. initProvider is safe to call without awaiting
  // because it never throws; .catch() is belt-and-suspenders.
  void waitForInit(state).catch(() => {
    /* initProvider records errors in state.error */
  });
}

/**
 * Create a sandbox server for Smithery/MCPB.
 */
export function createSandboxServer(): { tools: McpTool[] } {
  return { tools: [] };
}

/**
 * Read and validate server.json manifest.
 */
export function getServerManifest(): Record<string, unknown> {
  return {
    name: 'email-agent-mcp',
    version: PACKAGE_VERSION,
    description: 'Email connectivity for AI agents via MCP',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'email-agent-mcp', 'serve'],
    },
  };
}
