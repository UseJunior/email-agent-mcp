#!/usr/bin/env node
import { runCli } from '@usejunior/email-mcp';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
