import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolContractError } from './isolated-runtime-contract.mjs';

test('runtime contract accepts exact identities regardless of order', () => {
  assert.equal(toolContractError([{ name: 'b' }, { name: 'a' }], ['a', 'b']), null);
});
test('runtime contract rejects missing, extra and substituted tools', () => {
  for (const names of [['a'], ['a', 'b', 'c'], ['a', 'c']]) {
    assert.match(toolContractError(names.map(name => ({ name })), ['a', 'b']), /mismatch/);
  }
});
test('runtime contract rejects duplicate names even when count matches', () => {
  assert.match(toolContractError([{ name: 'a' }, { name: 'a' }], ['a', 'b']), /Duplicate/);
});
test('runtime contract rejects malformed tool responses', () => {
  for (const tools of [undefined, {}, [null], [{}], [{ name: 1 }]]) {
    assert.match(toolContractError(tools, ['a']), /Malformed/);
  }
});
