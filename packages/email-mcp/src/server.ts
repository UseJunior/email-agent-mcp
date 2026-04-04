// MCP server — thin transport adapter mapping action registry to MCP tools
import { createRequire } from 'node:module';
import type { EmailAction, EmailProvider } from '@usejunior/email-core';
import { z } from 'zod';

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

  const input = action.input.parse(args);
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
 * Run the MCP server on stdio.
 * Checks for saved auth tokens and connects to real Graph API if available.
 * Falls back to demo mode if no tokens found.
 */
export async function runServer(): Promise<void> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  // Load send allowlist at startup (convention: ~/.email-agent-mcp/send-allowlist.json)
  const { loadSendAllowlist, getSendAllowlistPath } = await import('@usejunior/email-core');
  const sendAllowlistPath = getSendAllowlistPath();
  const sendAllowlist = await loadSendAllowlist(sendAllowlistPath);
  if (sendAllowlist && sendAllowlist.entries.length > 0) {
    console.error(`[email-agent-mcp] Send allowlist loaded: ${sendAllowlist.entries.length} entries from ${sendAllowlistPath}`);
  } else {
    console.error(`[email-agent-mcp] WARNING: Send allowlist empty or not found at ${sendAllowlistPath} — all outbound email is disabled`);
  }

  // Try to load real provider from saved tokens — try each mailbox, skip failures
  let actions: EmailActionDef[] = await buildDemoActions();
  let actionCtx: unknown = {};

  try {
    const { listConfiguredMailboxesWithMetadata, DelegatedAuthManager } = await import('@usejunior/provider-microsoft');
    const { RealGraphApiClient, GraphEmailProvider } = await import('@usejunior/provider-microsoft');
    const allMailboxes = await listConfiguredMailboxesWithMetadata();

    if (allMailboxes.length > 0) {
      let connected = false;

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

          // Build real actions from the provider
          actions = await buildRealActions(provider, auth, sendAllowlist);
          console.error(`[email-agent-mcp] Connected to mailbox "${displayName}" (${metadata.clientId})`);
          connected = true;
          break;
        } catch (err) {
          console.error(`[email-agent-mcp] Skipping mailbox "${displayName}": ${err instanceof Error ? err.message : err}`);
          continue;
        }
      }

      if (!connected) {
        actions = await buildDemoActions();
        console.error('[email-agent-mcp] WARNING: All configured mailboxes failed to authenticate — running in demo mode. Run: email-agent-mcp configure');
      }
    } else {
      actions = await buildDemoActions();
      console.error('[email-agent-mcp] No configured mailboxes — running in demo mode');
      console.error('[email-agent-mcp] Run: email-agent-mcp configure --mailbox <name> --provider microsoft');
    }
  } catch (err) {
    actions = await buildDemoActions();
    console.error(`[email-agent-mcp] Could not connect to real provider: ${err instanceof Error ? err.message : err}`);
    console.error('[email-agent-mcp] Running in demo mode');
  }

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
      return await handleToolCall(actions, actionCtx, name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }) as never);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[email-agent-mcp] MCP server started on stdio (${tools.length} tools)`);
}

// Import z lazily for action definitions
async function buildRealActions(provider: EmailProvider, auth: { getTokenHealthWarning: () => string | undefined; tryReconnect: () => Promise<boolean> }, sendAllowlist?: { entries: string[] }): Promise<EmailActionDef[]> {
  const { z } = await import('zod');
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

  // Build ActionContext for send/reply actions
  const actionCtx = { provider: provider as never, sendAllowlist };
  const wrapAction = (action: EmailAction<any, any>): EmailActionDef => ({
    name: action.name,
    description: action.description,
    input: action.input,
    output: action.output,
    annotations: action.annotations,
    run: async (_ctx, input) => action.run(actionCtx as never, input as never),
  });

  return [
    {
      name: 'list_emails',
      description: 'List recent emails with filtering by unread status, folder, sender, and limit. Use offset for pagination.',
      input: z.object({ mailbox: z.string().optional(), unread: z.boolean().optional(), limit: z.number().optional(), offset: z.number().optional(), folder: z.string().optional() }),
      output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean() })) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async (_ctx, input) => {
        const inp = input as { unread?: boolean; limit?: number; offset?: number; folder?: string };
        const messages = await provider.listMessages({ unread: inp.unread, limit: inp.limit ?? 25, offset: inp.offset, folder: inp.folder ?? 'inbox' });
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
        const inp = input as { id: string };
        const msg = await provider.getMessage(inp.id) as { id: string; subject: string; from: { email: string; name?: string }; to: Array<{ email: string; name?: string }>; receivedAt: string; body?: string; bodyHtml?: string };

        // Transform HTML to markdown, or use plaintext body
        let emailBody = '';
        if (msg.bodyHtml) {
          try {
            const { htmlToMarkdown } = await import('@usejunior/email-core');
            emailBody = htmlToMarkdown(msg.bodyHtml);
          } catch {
            emailBody = msg.bodyHtml; // fallback to raw HTML
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
        const inp = input as { query: string; limit?: number; offset?: number };
        const results = await provider.searchMessages(inp.query, undefined, inp.limit, inp.offset) as Array<{ id: string; subject: string; from: { email: string; name?: string }; receivedAt: string; isRead: boolean; hasAttachments: boolean }>;
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
      run: async () => {
        const warnings: string[] = [];
        const healthWarning = auth.getTokenHealthWarning();
        if (healthWarning) warnings.push(healthWarning);
        if (!sendAllowlist || sendAllowlist.entries.length === 0) {
          warnings.push('Send allowlist not configured — all outbound email is disabled. Run: email-agent-mcp configure');
        }
        return { name: 'default', provider: 'microsoft', status: 'connected', isDefault: true, warnings };
      },
    },
    {
      name: sendEmailAction.name,
      description: sendEmailAction.description,
      input: sendEmailAction.input,
      output: sendEmailAction.output,
      annotations: sendEmailAction.annotations,
      run: async (_ctx, input) => sendEmailAction.run(actionCtx as never, input as never),
    },
    {
      name: replyToEmailAction.name,
      description: replyToEmailAction.description,
      input: replyToEmailAction.input,
      output: replyToEmailAction.output,
      annotations: replyToEmailAction.annotations,
      run: async (_ctx, input) => replyToEmailAction.run(actionCtx as never, input as never),
    },
    {
      name: createDraftAction.name,
      description: createDraftAction.description,
      input: createDraftAction.input,
      output: createDraftAction.output,
      annotations: createDraftAction.annotations,
      run: async (_ctx, input) => createDraftAction.run(actionCtx as never, input as never),
    },
    {
      name: sendDraftAction.name,
      description: sendDraftAction.description,
      input: sendDraftAction.input,
      output: sendDraftAction.output,
      annotations: sendDraftAction.annotations,
      run: async (_ctx, input) => sendDraftAction.run(actionCtx as never, input as never),
    },
    {
      name: updateDraftAction.name,
      description: updateDraftAction.description,
      input: updateDraftAction.input,
      output: updateDraftAction.output,
      annotations: updateDraftAction.annotations,
      run: async (_ctx, input) => updateDraftAction.run(actionCtx as never, input as never),
    },
    wrapAction(getThreadAction),
    wrapAction(labelEmailAction),
    wrapAction(flagEmailAction),
    wrapAction(markReadAction),
    wrapAction(moveToFolderAction),
    wrapAction(deleteEmailAction),
  ];
}

async function buildDemoActions(): Promise<EmailActionDef[]> {
  const { z } = await import('zod');
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
  const demoError = {
    success: false,
    error: {
      code: 'DEMO_MODE',
      message: 'Demo mode — run email-agent-mcp configure to connect a mailbox',
      recoverable: false,
    },
  };
  const demoFailureAction = (action: EmailAction<any, any>): EmailActionDef => ({
    name: action.name,
    description: action.description,
    input: action.input,
    output: action.output,
    annotations: action.annotations,
    run: async () => demoError,
  });

  return [
    {
      name: 'list_emails', description: 'List recent emails', input: z.object({ unread: z.boolean().optional(), limit: z.number().optional(), folder: z.string().optional() }), output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean() })) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async () => ({ emails: [{ id: 'demo-1', subject: 'Demo mode — run email-agent-mcp configure to connect', from: 'system@email-agent-mcp.dev', receivedAt: new Date().toISOString(), isRead: false, hasAttachments: false }] }),
    },
    {
      name: 'read_email', description: 'Read email by ID', input: z.object({ id: z.string() }), output: z.object({ id: z.string(), subject: z.string(), from: z.string(), to: z.array(z.string()), body: z.string(), receivedAt: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async (_ctx, input) => ({ id: (input as {id:string}).id, subject: 'Demo mode', from: 'system@email-agent-mcp.dev', to: ['user@example.com'], body: 'No mailbox configured. Run: email-agent-mcp configure --mailbox <name> --provider microsoft', receivedAt: new Date().toISOString() }),
    },
    {
      name: 'search_emails', description: 'Search emails', input: z.object({ query: z.string() }), output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean() })) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async () => ({ emails: [] }),
    },
    {
      name: 'get_mailbox_status', description: 'Get mailbox status', input: z.object({ mailbox: z.string().optional() }), output: z.object({ name: z.string(), provider: z.string(), status: z.string(), isDefault: z.boolean(), warnings: z.array(z.string()) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: async () => ({ name: 'none', provider: 'none', status: 'not configured', isDefault: false, warnings: ['No mailbox configured. Run: email-agent-mcp configure --mailbox <name> --provider microsoft'] }),
    },
    {
      name: getThreadAction.name,
      description: getThreadAction.description,
      input: getThreadAction.input,
      output: getThreadAction.output,
      annotations: getThreadAction.annotations,
      run: async () => ({
        id: 'demo-thread-1',
        subject: 'Demo mode',
        messages: [{
          id: 'demo-1',
          subject: 'Demo mode',
          from: 'system@email-agent-mcp.dev',
          receivedAt: new Date().toISOString(),
          body: 'No mailbox configured. Run: email-agent-mcp configure --mailbox <name> --provider microsoft',
          isRead: false,
        }],
        messageCount: 1,
        isTruncated: false,
      }),
    },
    demoFailureAction(sendEmailAction),
    demoFailureAction(replyToEmailAction),
    demoFailureAction(createDraftAction),
    demoFailureAction(sendDraftAction),
    demoFailureAction(updateDraftAction),
    demoFailureAction(labelEmailAction),
    demoFailureAction(flagEmailAction),
    demoFailureAction(markReadAction),
    demoFailureAction(moveToFolderAction),
    demoFailureAction(deleteEmailAction),
  ];
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
