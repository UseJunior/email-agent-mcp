import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['packages/email-agent-mcp/bin/email-agent-mcp.js', 'serve'],
  cwd: process.cwd(),
  env: { ...process.env },
  stderr: 'inherit',
});

const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
await client.connect(transport);

console.log('Searching for install.sh email...');
const searchResult = await client.callTool({ name: 'search_emails', arguments: { query: 'install.sh cleanup local variables' } });
const searchData = JSON.parse(searchResult.content[0].text);
console.log(`Found ${searchData.emails.length} results`);

if (searchData.emails.length > 0) {
  const email = searchData.emails[0];
  console.log(`\nReading: "${email.subject}"`);
  const readResult = await client.callTool({ name: 'read_email', arguments: { id: email.id } });
  const readData = JSON.parse(readResult.content[0].text);
  console.log(`Body length: ${readData.body.length}`);
  console.log(`Body (raw, first 500):\n${JSON.stringify(readData.body).substring(0, 500)}`);
}

await client.close();
