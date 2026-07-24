import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('sensitive local video artifacts are ignored by default', () => {
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const entry of [
    'captures/',
    'project.local.json',
    'recording.local.json',
    '.work/',
    'dist/',
  ]) {
    assert.match(ignore, new RegExp(`^${entry.replace('.', '\\.')}\\s*$`, 'm'));
  }
});

test('AppleScript uses native app scripting without Accessibility keystrokes', () => {
  const script = readFileSync(
    new URL('../scripts/macos/recording-director.applescript', import.meta.url),
    'utf8',
  );
  assert.match(script, /tell application "Terminal"/);
  assert.match(script, /do script/);
  assert.doesNotMatch(script, /System Events|keystroke|key code/);
});
