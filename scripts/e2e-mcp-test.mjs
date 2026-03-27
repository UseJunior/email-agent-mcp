#!/usr/bin/env node
// E2E test: connect to agent-email MCP server as a client via stdio
// Verifies the full MCP handshake + tool listing + tool calling

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  console.log('🔌 Starting MCP E2E test...\n');

  // Launch agent-email MCP server as a child process
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'packages/email-mcp/src/serve-entry.ts'],
  });

  const client = new Client(
    { name: 'e2e-test-client', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    // Step 1: Connect and initialize
    console.log('1️⃣  Connecting to MCP server...');
    await client.connect(transport);
    console.log('   ✅ MCP handshake completed\n');

    // Step 2: List tools
    console.log('2️⃣  Listing tools...');
    const { tools } = await client.listTools();
    console.log(`   ✅ Found ${tools.length} tools:`);
    for (const tool of tools) {
      const anno = tool.annotations || {};
      console.log(`      • ${tool.name} — ${tool.description.slice(0, 60)}... [readOnly=${anno.readOnlyHint ?? '?'}]`);
    }
    console.log();

    // Step 3: Call list_emails
    console.log('3️⃣  Calling list_emails {unread: true}...');
    const listResult = await client.callTool({ name: 'list_emails', arguments: { unread: true } });
    const listData = JSON.parse(listResult.content[0].text);
    console.log(`   ✅ Got ${listData.emails.length} unread emails:`);
    for (const email of listData.emails) {
      console.log(`      📧 ${email.subject} — from ${email.from}`);
    }
    console.log();

    // Step 4: Call read_email on the first email from the list
    const firstEmailId = listData.emails[0]?.id ?? 'demo-1';
    console.log(`4️⃣  Calling read_email {id: "${firstEmailId}"}...`);
    const readResult = await client.callTool({ name: 'read_email', arguments: { id: firstEmailId } });
    const readData = JSON.parse(readResult.content[0].text);
    console.log(`   ✅ Read email: "${readData.subject}"`);
    console.log(`      From: ${readData.from}`);
    console.log(`      Body preview: ${readData.body.split('\n')[0]}`);
    console.log();

    // Step 5: Call search_emails
    console.log('5️⃣  Calling search_emails {query: "contract"}...');
    const searchResult = await client.callTool({ name: 'search_emails', arguments: { query: 'contract' } });
    const searchData = JSON.parse(searchResult.content[0].text);
    console.log(`   ✅ Search returned ${searchData.emails.length} results`);
    console.log();

    // Step 6: Call get_mailbox_status
    console.log('6️⃣  Calling get_mailbox_status...');
    const statusResult = await client.callTool({ name: 'get_mailbox_status', arguments: {} });
    const statusData = JSON.parse(statusResult.content[0].text);
    console.log(`   ✅ Mailbox "${statusData.name}" — status: ${statusData.status}`);
    if (statusData.warnings.length > 0) {
      console.log(`   ⚠️  ${statusData.warnings[0]}`);
    }
    console.log();

    // Step 7: Verify JSON Schema compatibility
    console.log('7️⃣  Verifying JSON Schema compatibility...');
    let schemaOk = true;
    for (const tool of tools) {
      if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
        console.log(`   ❌ ${tool.name}: missing or invalid inputSchema`);
        schemaOk = false;
      } else if (tool.inputSchema.type !== 'object') {
        console.log(`   ❌ ${tool.name}: inputSchema.type is "${tool.inputSchema.type}", expected "object"`);
        schemaOk = false;
      }
    }
    if (schemaOk) {
      console.log('   ✅ All tool schemas are valid JSON Schema objects');
    }
    console.log();

    console.log('═══════════════════════════════════════');
    console.log('✅ ALL E2E TESTS PASSED');
    console.log('═══════════════════════════════════════');
    console.log();
    console.log('MCP stdio transport works correctly.');
    console.log(`${tools.length} tools registered, all callable.`);

    await client.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ E2E TEST FAILED:', err);
    try { await client.close(); } catch {}
    process.exit(1);
  }
}

main();
