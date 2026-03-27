#!/usr/bin/env node
// Real MCP server using @modelcontextprotocol/sdk — stdio transport
// This is the entry point for `npx @usejunior/agent-email serve`

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { actionsToMcpTools, handleToolCall, type EmailActionDef } from './server.js';

// Demo actions for E2E testing — no real email provider needed
const demoActions: EmailActionDef[] = [
  {
    name: 'list_emails',
    description: 'List recent emails with filtering by unread status, folder, sender, and limit',
    input: z.object({
      mailbox: z.string().optional(),
      unread: z.boolean().optional(),
      limit: z.number().optional(),
      folder: z.string().optional(),
    }),
    output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean() })) }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    run: async (_ctx, input) => {
      const inp = input as { unread?: boolean; limit?: number; folder?: string };
      return {
        emails: [
          { id: 'demo-1', subject: 'Welcome to agent-email', from: 'system@agent-email.dev', receivedAt: new Date().toISOString(), isRead: false, hasAttachments: false },
          { id: 'demo-2', subject: 'MCP Integration Test', from: 'test@example.com', receivedAt: new Date().toISOString(), isRead: true, hasAttachments: true },
          { id: 'demo-3', subject: 'Contract Review — Q1 2024', from: 'alice@corp.com', receivedAt: new Date().toISOString(), isRead: false, hasAttachments: true },
        ].filter(e => inp.unread ? !e.isRead : true).slice(0, inp.limit ?? 25),
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
      const emails: Record<string, { subject: string; from: string; body: string }> = {
        'demo-1': { subject: 'Welcome to agent-email', from: 'system@agent-email.dev', body: '# Welcome to agent-email!\n\nThis is a demo email from the MCP E2E test.\n\nThe agent-email MCP server is working correctly with stdio transport.\n\n## Features\n- Multi-mailbox support\n- Send allowlist security\n- Content engine (HTML → markdown)' },
        'demo-2': { subject: 'MCP Integration Test', from: 'test@example.com', body: 'This is a test email to verify MCP tool call dispatch works correctly.\n\nAttachments: report.pdf (245KB)' },
        'demo-3': { subject: 'Contract Review — Q1 2024', from: 'alice@corp.com', body: 'Hi,\n\nPlease review the attached contract for the Q1 partnership.\n\nAttachments: contract.docx (1.2MB), appendix.pdf (340KB)' },
      };
      const email = emails[inp.id] ?? { subject: 'Unknown', from: 'unknown@example.com', body: 'Email not found' };
      return {
        id: inp.id,
        subject: email.subject,
        from: email.from,
        to: ['user@example.com'],
        body: email.body,
        receivedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails using full-text query across one or all mailboxes',
    input: z.object({ query: z.string(), mailbox: z.string().optional(), limit: z.number().optional() }),
    output: z.object({ emails: z.array(z.object({ id: z.string(), subject: z.string(), from: z.string(), receivedAt: z.string(), isRead: z.boolean(), hasAttachments: z.boolean() })) }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    run: async (_ctx, input) => {
      const inp = input as { query: string };
      return {
        emails: [
          { id: 'search-1', subject: `Result for: ${inp.query}`, from: 'search@example.com', receivedAt: new Date().toISOString(), isRead: false, hasAttachments: false },
        ],
      };
    },
  },
  {
    name: 'get_mailbox_status',
    description: 'Get mailbox connection status, unread count, and warnings',
    input: z.object({ mailbox: z.string().optional() }),
    output: z.object({ name: z.string(), provider: z.string(), status: z.string(), isDefault: z.boolean(), warnings: z.array(z.string()) }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    run: async () => ({
      name: 'demo',
      provider: 'demo',
      status: 'connected',
      isDefault: true,
      warnings: ['This is a demo mailbox — no real email provider configured'],
    }),
  },
];

async function main(): Promise<void> {
  const server = new Server(
    { name: 'agent-email', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const tools = actionsToMcpTools(demoActions);

  // Register tools/list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // Register tools/call handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.setRequestHandler(CallToolRequestSchema, (async (request: any) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(demoActions, {}, name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }) as never);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agent-email] MCP server started on stdio (4 demo tools)');
}

main().catch(err => {
  console.error('[agent-email] Fatal error:', err);
  process.exit(1);
});
