#!/usr/bin/env node
import { runCliDirect } from '@usejunior/email-mcp';

// runCliDirect sets process.exitCode (not process.exit) so `serve` can stay
// alive for the MCP stdio handshake while one-shot subcommands like `call`
// propagate their non-zero exit codes to the shell.
runCliDirect(process.argv.slice(2));
