#!/usr/bin/env node
// Entry point for running the real MCP server
import { runServer } from './server.js';

runServer().catch(err => {
  console.error('[agent-email] Fatal error:', err);
  process.exit(1);
});
