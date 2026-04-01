#!/usr/bin/env node

/**
 * Validates that server.json version stays in sync with package.json.
 * Run via: npm run check:server-json
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const serverJson = JSON.parse(
  readFileSync(resolve(root, 'packages/email-agent-mcp/server.json'), 'utf-8'),
);
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'packages/email-agent-mcp/package.json'), 'utf-8'),
);

let ok = true;

if (serverJson.version !== packageJson.version) {
  console.error(
    `FAIL: server.json version "${serverJson.version}" !== package.json version "${packageJson.version}"`,
  );
  ok = false;
}

if (serverJson.name !== packageJson.mcpName) {
  console.error(
    `FAIL: server.json name "${serverJson.name}" !== package.json mcpName "${packageJson.mcpName}"`,
  );
  ok = false;
}

const pkgEntry = serverJson.packages?.[0];
if (pkgEntry && pkgEntry.version !== packageJson.version) {
  console.error(
    `FAIL: server.json packages[0].version "${pkgEntry.version}" !== package.json version "${packageJson.version}"`,
  );
  ok = false;
}

if (pkgEntry && pkgEntry.identifier !== packageJson.name) {
  console.error(
    `FAIL: server.json packages[0].identifier "${pkgEntry.identifier}" !== package.json name "${packageJson.name}"`,
  );
  ok = false;
}

if (ok) {
  console.log(
    `PASS: server.json matches package.json (${packageJson.version})`,
  );
} else {
  process.exit(1);
}
