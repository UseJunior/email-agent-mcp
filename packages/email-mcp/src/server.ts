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

export interface LazyMailboxState {
  name: string;
  emailAddress?: string;
  displayName: string;
  providerType: 'microsoft' | 'gmail';
  provider: EmailProvider | null;
  auth: LazyProviderAuth | null;
  isDefault: boolean;
  status: 'connected' | 'error';
  error?: string;
}

interface ConnectedLazyMailboxState extends LazyMailboxState {
  provider: EmailProvider;
  status: 'connected';
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
  connectedProvider: 'microsoft' | 'gmail' | null;
  mailboxes: LazyMailboxState[];
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
    connectedProvider: null,
    mailboxes: [],
  };
}

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

const MANUAL_GMAIL_SETUP_HINT =
  'or add a Gmail mailbox JSON file under ~/.email-agent-mcp/tokens/. See packages/provider-gmail/README.md';
const NO_MAILBOX_CONFIGURED_MESSAGE =
  `No mailbox configured — run: email-agent-mcp configure --mailbox <name> --provider microsoft ${MANUAL_GMAIL_SETUP_HINT}`;

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
 * Convert a Zod schema to JSON Schema for MCP `tools/list`.
 *
 * Uses Zod v4's first-party `z.toJSONSchema` with `io: 'input'`. Input mode
 * is the semantically correct one for tool input schemas: fields with
 * defaults are not marked required (because the client may omit them), and
 * the emitted shape describes what the client sends, not what the parser
 * produces.
 *
 * Historical note: this used to feature-detect a misspelled `toJsonSchema`
 * (lowercase `s`), which never existed in Zod v4. The primary path
 * silently fell through to a hand-rolled generator that returned `{}` for
 * `ZodUnion`, which is why `send_email.to` (a `string | string[]` union)
 * previously emitted `{}` in `tools/list` and some MCP clients couldn't
 * validate calls to it. Fixed by calling the real API directly.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
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
  if (!getDefaultMailbox(state)) {
    throw new Error(state.error ?? NO_MAILBOX_CONFIGURED_MESSAGE);
  }
}

interface ResolvedMailboxContext {
  mailbox: ConnectedLazyMailboxState;
  allMailboxes: Array<{
    name: string;
    emailAddress?: string;
    provider: EmailProvider;
    providerType: string;
    isDefault: boolean;
    status: 'connected';
  }>;
}

function normalizeMailboxKey(value: string): string {
  return value.trim().toLowerCase();
}

function fallbackConnectedMailbox(state: LazyProviderState): LazyMailboxState[] {
  if (!state.provider) return [];
  return [
    {
      name: state.connectedMailbox ?? 'default',
      emailAddress: state.connectedMailbox ?? undefined,
      displayName: state.connectedMailbox ?? 'default',
      providerType: state.connectedProvider ?? 'microsoft',
      provider: state.provider,
      auth: state.auth,
      isDefault: true,
      status: 'connected',
    },
  ];
}

function getKnownMailboxes(state: LazyProviderState): LazyMailboxState[] {
  return state.mailboxes.length > 0 ? state.mailboxes : fallbackConnectedMailbox(state);
}

function isConnectedMailbox(mailbox: LazyMailboxState): mailbox is ConnectedLazyMailboxState {
  return mailbox.status === 'connected' && mailbox.provider !== null;
}

function getConnectedMailboxes(state: LazyProviderState): ConnectedLazyMailboxState[] {
  return getKnownMailboxes(state).filter(isConnectedMailbox);
}

function getDefaultMailbox(state: LazyProviderState): ConnectedLazyMailboxState | null {
  const connected = getConnectedMailboxes(state);
  return connected.find(mailbox => mailbox.isDefault) ?? connected[0] ?? null;
}

function findKnownMailbox(state: LazyProviderState, mailboxName: string): LazyMailboxState | null {
  const target = normalizeMailboxKey(mailboxName);
  return (
    getKnownMailboxes(state).find(mailbox =>
      normalizeMailboxKey(mailbox.name) === target ||
      normalizeMailboxKey(mailbox.displayName) === target ||
      (mailbox.emailAddress ? normalizeMailboxKey(mailbox.emailAddress) === target : false),
    ) ?? null
  );
}

function describeConfiguredMailboxes(state: LazyProviderState): string {
  const names = getKnownMailboxes(state).map(mailbox => mailbox.emailAddress ?? mailbox.name);
  return names.length > 0 ? names.join(', ') : 'none';
}

function resolveMailboxContext(
  state: LazyProviderState,
  requestedMailbox?: string,
): ResolvedMailboxContext {
  const connectedMailboxes = getConnectedMailboxes(state);
  if (connectedMailboxes.length === 0) {
    throw new Error(state.error ?? NO_MAILBOX_CONFIGURED_MESSAGE);
  }

  const mailbox = requestedMailbox ? findKnownMailbox(state, requestedMailbox) : getDefaultMailbox(state);

  if (!mailbox) {
    throw new Error(
      `Mailbox "${requestedMailbox}" is not configured. Available mailboxes: ${describeConfiguredMailboxes(state)}`,
    );
  }

  if (!isConnectedMailbox(mailbox)) {
    throw new Error(mailbox.error ?? `Mailbox "${requestedMailbox ?? mailbox.name}" is not connected`);
  }

  return {
    mailbox,
    allMailboxes: connectedMailboxes.map(connected => ({
      name: connected.name,
      emailAddress: connected.emailAddress,
      provider: connected.provider,
      providerType: connected.providerType,
      isDefault: connected.isDefault,
      status: 'connected' as const,
    })),
  };
}

/**
 * Background-safe provider initialization. Iterates configured mailboxes,
 * records success or failure on `state`. **Never throws** — fire-and-forget
 * callers rely on this invariant.
 */
export async function initProvider(state: LazyProviderState): Promise<void> {
  try {
    const [
      { listConfiguredMailboxesWithMetadata, DelegatedAuthManager, RealGraphApiClient, GraphEmailProvider },
      { listConfiguredGmailMailboxes, GmailAuthManager, GmailEmailProvider, GoogleapisGmailClient },
    ] = await Promise.all([
      import('@usejunior/provider-microsoft'),
      import('@usejunior/provider-gmail'),
    ]);
    const microsoftMailboxes = await listConfiguredMailboxesWithMetadata();
    const gmailMailboxes = await listConfiguredGmailMailboxes();

    if (microsoftMailboxes.length === 0 && gmailMailboxes.length === 0) {
      state.isDemo = true;
      state.status = 'not_configured';
      state.mailboxes = [];
      console.error('[email-agent-mcp] No configured mailboxes — running in demo mode');
      console.error(`[email-agent-mcp] ${NO_MAILBOX_CONFIGURED_MESSAGE}`);
      return;
    }

    const connectedMailboxes: LazyMailboxState[] = [];
    const failedMailboxes: LazyMailboxState[] = [];

    for (const metadata of microsoftMailboxes) {
      const displayName = metadata.emailAddress ?? metadata.mailboxName;
      try {
        const auth = new DelegatedAuthManager(
          { mode: 'delegated', clientId: metadata.clientId, tenantId: metadata.tenantId },
          metadata.mailboxName,
        );
        await auth.reconnect();
        const client = new RealGraphApiClient(() => auth.getAccessToken(), () => auth.tryReconnect());
        const provider = new GraphEmailProvider(client);

        const mailboxAuth = {
          getTokenHealthWarning: () => auth.getTokenHealthWarning(),
          tryReconnect: () => auth.tryReconnect(),
        };

        connectedMailboxes.push({
          name: metadata.mailboxName,
          emailAddress: metadata.emailAddress,
          displayName,
          providerType: 'microsoft',
          provider,
          auth: mailboxAuth,
          isDefault: false,
          status: 'connected',
        });

        console.error(`[email-agent-mcp] Connected to mailbox "${displayName}" (${metadata.clientId})`);
      } catch (err) {
        failedMailboxes.push({
          name: metadata.mailboxName,
          emailAddress: metadata.emailAddress,
          displayName,
          providerType: 'microsoft',
          provider: null,
          auth: null,
          isDefault: false,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[email-agent-mcp] Skipping mailbox "${displayName}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    for (const metadata of gmailMailboxes) {
      const displayName = metadata.emailAddress ?? metadata.mailboxName;
      try {
        const auth = new GmailAuthManager({
          clientId: metadata.clientId,
          clientSecret: metadata.clientSecret,
          redirectUri: metadata.redirectUri,
        });
        await auth.connect({ refresh_token: metadata.refreshToken });
        await auth.refresh();

        const client = new GoogleapisGmailClient(auth);
        const provider = new GmailEmailProvider(client);

        connectedMailboxes.push({
          name: metadata.mailboxName,
          emailAddress: metadata.emailAddress,
          displayName,
          providerType: 'gmail',
          provider,
          auth: null,
          isDefault: false,
          status: 'connected',
        });

        console.error(`[email-agent-mcp] Connected to Gmail mailbox "${displayName}" (${metadata.clientId})`);
      } catch (err) {
        failedMailboxes.push({
          name: metadata.mailboxName,
          emailAddress: metadata.emailAddress,
          displayName,
          providerType: 'gmail',
          provider: null,
          auth: null,
          isDefault: false,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[email-agent-mcp] Skipping Gmail mailbox "${displayName}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (connectedMailboxes.length > 0) {
      connectedMailboxes[0]!.isDefault = true;
      state.mailboxes = [...connectedMailboxes, ...failedMailboxes];
      state.provider = connectedMailboxes[0]!.provider;
      state.auth = connectedMailboxes[0]!.auth;
      state.connectedMailbox = connectedMailboxes[0]!.displayName;
      state.connectedProvider = connectedMailboxes[0]!.providerType;
      state.isDemo = false;
      state.status = 'connected';
      return;
    }

    // All configured mailboxes failed to authenticate.
    state.mailboxes = failedMailboxes;
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
    listAttachmentsAction,
    labelEmailAction,
    flagEmailAction,
    markReadAction,
    moveToFolderAction,
    deleteEmailAction,
  } = await import('@usejunior/email-core');

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
        const requestedMailbox =
          input && typeof input === 'object' && 'mailbox' in input &&
          typeof (input as { mailbox?: unknown }).mailbox === 'string'
            ? (input as { mailbox?: string }).mailbox
            : undefined;
        const resolved = resolveMailboxContext(state, requestedMailbox);
        const actionCtx = {
          provider: resolved.mailbox.provider,
          mailboxName: resolved.mailbox.name,
          allMailboxes: resolved.allMailboxes,
          sendAllowlist: getSendAllowlist(),
        };
        return action.run(actionCtx as never, input as never);
      } catch (err) {
        return providerUnavailableError(err);
      }
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
    body: NO_MAILBOX_CONFIGURED_MESSAGE,
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
        if (!getDefaultMailbox(state)) return demoListEmails();
        const inp = input as { mailbox?: string; unread?: boolean; limit?: number; offset?: number; folder?: string };
        const { mailbox } = resolveMailboxContext(state, inp.mailbox);
        const messages = await mailbox.provider.listMessages({
          unread: inp.unread,
          limit: inp.limit ?? 25,
          offset: inp.offset,
          folder: inp.folder ?? 'inbox',
        });
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
      output: z.object({
        id: z.string(),
        subject: z.string(),
        from: z.string(),
        to: z.array(z.string()),
        body: z.string(),
        receivedAt: z.string(),
        attachments: z.array(z.object({
          id: z.string(),
          filename: z.string(),
          mimeType: z.string(),
          size: z.number(),
          contentId: z.string().optional(),
          isInline: z.boolean(),
        })).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async (_ctx, input) => {
        await waitForInit(state);
        const inp = input as { id: string; mailbox?: string };
        if (!getDefaultMailbox(state)) return demoReadEmail(inp.id);
        const { mailbox } = resolveMailboxContext(state, inp.mailbox);
        const msg = await mailbox.provider.getMessage(inp.id) as {
          id: string;
          subject: string;
          from: { email: string; name?: string };
          to: Array<{ email: string; name?: string }>;
          receivedAt: string;
          body?: string;
          bodyHtml?: string;
          attachments?: Array<{
            id: string;
            filename: string;
            mimeType: string;
            size: number;
            contentId?: string;
            isInline: boolean;
          }>;
        };

        let emailBody = '';
        try {
          const { transformEmailContent } = await import('@usejunior/email-core');
          emailBody = transformEmailContent(msg.body, msg.bodyHtml, msg.attachments);
        } catch {
          emailBody = msg.bodyHtml ?? msg.body ?? '';
        }

        return {
          id: msg.id,
          subject: msg.subject,
          from: msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email,
          to: msg.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email),
          body: emailBody,
          receivedAt: msg.receivedAt,
          attachments: msg.attachments?.map(attachment => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            contentId: attachment.contentId,
            isInline: attachment.isInline,
          })),
        };
      },
    },
    {
      name: 'search_emails',
      description: 'Search emails using full-text query across one or all mailboxes. Use offset for pagination.',
      input: z.object({ query: z.string(), mailbox: z.string().nullable().optional(), limit: z.number().optional(), offset: z.number().optional() }),
      output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean(), mailbox: z.string().optional() })) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async (_ctx, input) => {
        await waitForInit(state);
        if (!getDefaultMailbox(state)) return { emails: [] };
        const inp = input as { query: string; mailbox?: string | null; limit?: number; offset?: number };
        const resolved = inp.mailbox === null ? null : resolveMailboxContext(state, inp.mailbox);
        const results = resolved
          ? (await resolved.mailbox.provider.searchMessages(
            inp.query,
            undefined,
            inp.limit ?? 25,
            inp.offset,
          ) as Array<{
            id: string;
            subject: string;
            from: { email: string; name?: string };
            receivedAt: string;
            isRead: boolean;
            hasAttachments: boolean;
          }>).map(result => ({ ...result, mailbox: resolved.mailbox.name }))
          : (await Promise.all(
            getConnectedMailboxes(state).map(async mailbox => {
              const mailboxResults = await mailbox.provider.searchMessages(inp.query, undefined);
              return mailboxResults.map(result => ({ ...result, mailbox: mailbox.name }));
            }),
          ))
            .flat()
            .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
            .slice(inp.offset ?? 0, (inp.offset ?? 0) + (inp.limit ?? 25));
        return {
          emails: results.map(m => ({
            id: m.id,
            subject: m.subject,
            from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
            receivedAt: m.receivedAt,
            isRead: m.isRead,
            hasAttachments: m.hasAttachments,
            mailbox: m.mailbox,
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
      run: async (_ctx, input) => {
        const inp = (input ?? {}) as { mailbox?: string };
        const warnings: string[] = [];
        switch (state.status) {
          case 'pending':
          case 'connecting':
            return { name: 'pending', provider: 'pending', status: 'connecting', isDefault: false, warnings: ['Authenticating — provider is warming up'] };
          case 'not_configured':
            return { name: 'none', provider: 'none', status: 'not configured', isDefault: false, warnings: [NO_MAILBOX_CONFIGURED_MESSAGE] };
          case 'error':
            return { name: 'none', provider: 'none', status: 'error', isDefault: false, warnings: [state.error ?? 'Provider init failed'] };
          case 'connected': {
            const mailbox = inp.mailbox ? findKnownMailbox(state, inp.mailbox) : getDefaultMailbox(state);
            if (!mailbox) {
              return {
                name: inp.mailbox ?? 'unknown',
                provider: 'unknown',
                status: 'error',
                isDefault: false,
                warnings: [
                  `Mailbox "${inp.mailbox}" is not configured. Available mailboxes: ${describeConfiguredMailboxes(state)}`,
                ],
              };
            }

            if (mailbox.status !== 'connected') {
              return {
                name: mailbox.displayName,
                provider: mailbox.providerType,
                status: 'error',
                isDefault: mailbox.isDefault,
                warnings: [mailbox.error ?? `Mailbox "${mailbox.displayName}" is not connected`],
              };
            }

            const healthWarning = mailbox.auth?.getTokenHealthWarning();
            if (healthWarning) warnings.push(healthWarning);
            const currentAllowlist = getSendAllowlist();
            if (!currentAllowlist || currentAllowlist.entries.length === 0) {
              warnings.push('Send allowlist not configured — all outbound email is disabled. Run: email-agent-mcp configure');
            }
            return {
              name: mailbox.displayName,
              provider: mailbox.providerType,
              status: 'connected',
              isDefault: mailbox.isDefault,
              warnings,
            };
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
    wrapAction(listAttachmentsAction),
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
