#!/usr/bin/env node
// Standalone MCP server entry point — delegates to runServer() in server.ts.
// The real CLI dispatch (email-agent-mcp serve) goes through cli.ts → runServer,
// which connects the MCP transport instantly and defers OAuth to the first
// tool call. This file exists as a direct-invocation entry for tooling that
// prefers to spawn the server script directly.

import { runServer } from './server.js';

runServer().catch(err => {
  console.error('[email-agent-mcp] Fatal:', err);
  process.exit(1);
});
