import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('sensitive local video artifacts are ignored by default', () => {
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const entry of ['captures/', 'project.local.json', '.work/', 'dist/']) {
    assert.match(ignore, new RegExp(`^${entry.replace('.', '\\.')}\\s*$`, 'm'));
  }
});
