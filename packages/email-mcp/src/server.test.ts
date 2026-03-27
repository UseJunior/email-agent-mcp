import { describe, it, expect } from 'vitest';

// Spec: mcp-transport — All requirements
// Tests written FIRST (spec-driven). Implementation pending.

describe('mcp-transport/Action to Tool Mapping', () => {
  it('Scenario: Auto-registration', async () => {
    // WHEN a new action is added to EMAIL_ACTIONS in email-core
    // THEN it automatically appears as an MCP tool in the tools/list response
    expect.fail('Not implemented — awaiting MCP server');
  });
});

describe('mcp-transport/stdio Transport', () => {
  it('Scenario: MCP handshake', async () => {
    // WHEN an MCP client connects via stdio
    // THEN the server completes the MCP initialize handshake and lists all available tools
    expect.fail('Not implemented — awaiting MCP server');
  });
});

describe('mcp-transport/Zod Schema Constraints', () => {
  it('Scenario: Schema compatibility', async () => {
    // WHEN generating JSON Schema from Zod
    // THEN all tool input schemas are valid JSON Schema objects with no custom extensions
    expect.fail('Not implemented — awaiting Zod schema generation');
  });
});

describe('mcp-transport/Tool Annotations', () => {
  it('Scenario: Read action annotations', async () => {
    // WHEN list_emails tool is registered
    // THEN it has readOnlyHint: true, destructiveHint: false
    expect.fail('Not implemented — awaiting tool annotations');
  });
});

describe('mcp-transport/Server Discovery', () => {
  it('Scenario: server.json content', async () => {
    // WHEN server.json is read
    // THEN it contains name, version, description, and npm package transport configuration
    expect.fail('Not implemented — awaiting server.json validation');
  });
});
