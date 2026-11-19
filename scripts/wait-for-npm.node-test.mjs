import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForNpm } from './wait-for-npm.mjs';
const pkg = { registryType: 'npm', identifier: 'email-agent-mcp', version: '0.5.2' };
test('waits for exact npm version after propagation 404 and stale response', async () => {
  let calls = 0, pauses = 0;
  await waitForNpm([pkg], { attempts: 3, log: () => {}, pause: async () => { pauses++; }, fetchImpl: async url => {
    assert.equal(url, 'https://registry.npmjs.org/email-agent-mcp/0.5.2');
    calls++;
    return calls === 1 ? new Response('', { status: 404 }) : Response.json({ version: calls === 2 ? '0.5.1' : '0.5.2' });
  }});
  assert.equal(calls, 3); assert.equal(pauses, 2);
});
test('fails closed at deadline after network errors without a final sleep', async () => {
  let pauses = 0;
  await assert.rejects(waitForNpm([pkg], { attempts: 2, log: () => {}, pause: async () => { pauses++; }, fetchImpl: async () => { throw new Error('network'); } }), /deadline exceeded/);
  assert.equal(pauses, 1);
});
test('checks every npm metadata reference and URL-encodes scoped packages', async () => {
  const urls = [];
  await waitForNpm([pkg, { ...pkg, identifier: '@usejunior/email-core' }, { registryType: 'pypi' }], { fetchImpl: async url => { urls.push(url); return Response.json({ version: pkg.version }); } });
  assert.deepEqual(urls, ['https://registry.npmjs.org/email-agent-mcp/0.5.2', 'https://registry.npmjs.org/%40usejunior%2Femail-core/0.5.2']);
});
