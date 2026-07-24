import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  extractBrokerStartUrl,
  validateBrokerStartUrl,
} from '../scripts/live/broker-url.mjs';
import {
  buildCommandPlans,
  commandFileContents,
} from '../scripts/live/commands.mjs';
import {validateRecordingConfig} from '../scripts/live/config.mjs';
import {buildLiveOperatorScript} from '../scripts/live/operator-script.mjs';
import {validatePublishedScopeText} from '../scripts/live/public-artifact.mjs';
import {
  uniqueTakePath,
  verifyUsableDuration,
} from '../scripts/live/recording.mjs';
import {
  emptyRecordingState,
  readRecordingState,
  updateTakeState,
  writeRecordingState,
} from '../scripts/live/state.mjs';
import {buildDryRun, syncAcceptedTakes} from '../scripts/record-live.mjs';

function recordingConfig() {
  return {
    exampleOnly: false,
    packageVersion: '0.1.10',
    reviewMailbox: 'google-review@example.com',
    brokerUrl: 'https://oauth.usejunior.com',
    display: 1,
    maximumTakeSeconds: 300,
    emailAgentHome: '.work/live/email-agent-home',
    captureDirectory: 'captures/live',
    workDirectory: '.work/live',
    seedSubject: 'EA-MCP REVIEW READ 001',
    writeSubject: 'EA-MCP REVIEW WRITE 001',
    operatorConfirmations: {
      dedicatedEmptyMailbox: true,
      cleanEnglishBrowserProfile: true,
      focusModeEnabled: true,
      previousGrantRevoked: true,
      soleProductionWebClient: true,
    },
  };
}

test('recording configuration requires an exact release and constrained local paths', () => {
  const config = validateRecordingConfig(recordingConfig(), {requireConfirmations: true});
  assert.equal(config.packageSpec, 'email-agent-mcp@0.1.10');
  assert.equal(config.reviewMailbox, 'google-review@example.com');

  assert.throws(
    () => validateRecordingConfig({...recordingConfig(), packageVersion: 'latest'}),
    /exact published version/,
  );
  assert.throws(
    () => validateRecordingConfig({...recordingConfig(), captureDirectory: '../captures'}),
    /inside tools|must be captures/,
  );
});

test('online preflight can distinguish an unchanged example configuration', () => {
  const config = validateRecordingConfig({...recordingConfig(), exampleOnly: true});
  assert.equal(config.exampleOnly, true);
});

test('broker URL extraction permits only the production start route', () => {
  const url = 'https://oauth.usejunior.com/api/start?session=abc123';
  assert.equal(validateBrokerStartUrl(url), url);
  assert.equal(
    extractBrokerStartUrl(`prior output\n${url}\nwaiting`),
    url,
  );
  assert.throws(
    () => validateBrokerStartUrl('https://attacker.example/api/start?session=abc123'),
    /Refusing non-production broker URL/,
  );
  assert.throws(
    () => validateBrokerStartUrl('https://oauth.usejunior.com/api/start'),
    /missing its session/,
  );
});

test('command plans are deterministic, self-addressed, and explicitly avoid reply-all', () => {
  const config = validateRecordingConfig(recordingConfig());
  const plans = buildCommandPlans(config);
  const joined = Object.values(plans).flat().join('\n');
  assert.match(joined, /email-agent-mcp@0\.1\.10/);
  assert.match(joined, /google-review@example\.com/);
  assert.match(joined, /reply_all:false/);
  assert.match(joined, /strip_signatures:true/);
  assert.doesNotMatch(joined, /client[_-]?secret|refresh[_-]?token|access[_-]?token/i);
  assert.match(
    commandFileContents(plans.connected),
    /^#!\/bin\/zsh\nset -euo pipefail\nset -x/,
  );
});

test('dry-run and generated operator script cover all authentic capture IDs', () => {
  const config = validateRecordingConfig(recordingConfig());
  const script = buildLiveOperatorScript(config);
  const dryRun = buildDryRun(config);
  for (const id of [
    'identity',
    'auth-platform',
    'configure',
    'oauth-consent',
    'connected',
    'read',
    'send-reply',
    'revoke',
  ]) {
    assert.match(script, new RegExp(`Capture ID: \`${id}\``));
    assert.match(dryRun, new RegExp(id));
  }
  assert.match(dryRun, /no applications opened/i);
});

test('published artifact scope check rejects the legacy broad scope', () => {
  assert.equal(
    validatePublishedScopeText('https://www.googleapis.com/auth/gmail.modify'),
    true,
  );
  assert.throws(
    () => validatePublishedScopeText(
      'https://www.googleapis.com/auth/gmail.modify https://mail.google.com/',
    ),
    /legacy scope/,
  );
  assert.equal(
    validatePublishedScopeText(
      'https://www.googleapis.com/auth/gmail.modify https://attacker.example/https://mail.google.com/',
    ),
    true,
  );
  assert.equal(
    validatePublishedScopeText(
      'https://www.googleapis.com/auth/gmail.modify https://mail.google.com/.attacker.example',
    ),
    true,
  );
});

test('take paths never overwrite and usable duration includes inMs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-live-takes-'));
  try {
    const now = new Date('2026-07-24T12:34:56.000Z');
    const first = uniqueTakePath(directory, 'oauth-consent', now);
    writeFileSync(first, 'existing');
    const second = uniqueTakePath(directory, 'oauth-consent', now);
    assert.notEqual(second, first);
    assert.equal(existsSync(second), false);
    assert.equal(verifyUsableDuration({
      durationMs: 70_000,
      inMs: 5_000,
      requiredDurationMs: 65_000,
    }), 65_000);
    assert.throws(
      () => verifyUsableDuration({
        durationMs: 69_999,
        inMs: 5_000,
        requiredDurationMs: 65_000,
      }),
      /usable after inMs/,
    );
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('recording state is resumable and syncing accepted takes leaves attestations false', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oauth-live-state-'));
  const path = join(directory, 'state.json');
  try {
    const ids = ['identity', 'oauth-consent'];
    const state = emptyRecordingState(ids);
    updateTakeState(state, 'identity', {
      status: 'accepted',
      acceptedTake: {
        file: 'captures/live/identity.mov',
        durationMs: 20_000,
        sha256: 'a'.repeat(64),
      },
    });
    writeRecordingState(path, state);
    const restored = readRecordingState(path, ids);
    assert.equal(restored.captures.identity.status, 'accepted');

    const project = syncAcceptedTakes(validateRecordingConfig(recordingConfig()), {
      ...restored,
      captures: {
        ...emptyRecordingState([
          'identity',
          'auth-platform',
          'configure',
          'oauth-consent',
          'connected',
          'read',
          'send-reply',
          'revoke',
        ]).captures,
        identity: restored.captures.identity,
      },
    });
    assert.equal(project.captures.identity.file, 'captures/live/identity.mov');
    assert.ok(Object.values(project.attestations).every(value => value === false));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
