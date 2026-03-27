import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { actionsToMcpTools, handleToolCall, getServerManifest, type EmailActionDef } from './server.js';

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

    expect(manifest.name).toBe('agent-email');
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.transport).toBeDefined();
    const transport = manifest.transport as { type: string; command: string; args: string[] };
    expect(transport.type).toBe('stdio');
    expect(transport.command).toBe('npx');
  });
});
