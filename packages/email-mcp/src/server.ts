// MCP server — thin transport adapter mapping action registry to MCP tools
import { z } from 'zod';

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
 */
export async function runServer(): Promise<void> {
  // In real implementation: use @modelcontextprotocol/sdk
  console.error('[agent-email] MCP server started');
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
    name: 'agent-email',
    version: '0.1.0',
    description: 'Email connectivity for AI agents via MCP',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@usejunior/agent-email', 'serve'],
    },
  };
}
