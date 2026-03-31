#!/usr/bin/env node
// Validates gemini-extension.json version and structure contract

import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('gemini-extension.json', 'utf-8'));
const wrapperPkg = JSON.parse(readFileSync('packages/agent-email/package.json', 'utf-8'));

const errors = [];

// Required top-level fields
for (const field of ['name', 'version', 'description', 'contextFileName', 'entrypoint', 'mcpServers']) {
  if (!manifest[field]) {
    errors.push(`Missing required field: ${field}`);
  }
}

// Version must match wrapper package
if (manifest.version !== wrapperPkg.version) {
  errors.push(`Version mismatch: gemini-extension.json has ${manifest.version}, packages/agent-email/package.json has ${wrapperPkg.version}`);
}

// mcpServers must include agent-email
if (!manifest.mcpServers?.['agent-email']) {
  errors.push('mcpServers must include "agent-email" server');
}

// Validate MCP server command
const server = manifest.mcpServers?.['agent-email'];
if (server) {
  if (server.command !== 'npx') {
    errors.push(`agent-email server command must be "npx", got "${server.command}"`);
  }
  if (!server.args?.includes('@usejunior/agent-email')) {
    errors.push('agent-email server args must include "@usejunior/agent-email"');
  }
}

// contextFileName must point to existing file
if (manifest.contextFileName) {
  try {
    readFileSync(manifest.contextFileName, 'utf-8');
  } catch {
    errors.push(`contextFileName "${manifest.contextFileName}" does not exist`);
  }
}

if (errors.length > 0) {
  console.error('Gemini extension manifest validation failed:');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.error(`gemini-extension.json OK (v${manifest.version})`);
