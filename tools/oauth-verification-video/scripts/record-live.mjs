#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from './args.mjs';
import {fromToolRoot, toolRoot} from './paths.mjs';
import {captureRequirements} from '../src/core/project.mjs';
import {scenes} from '../src/storyboard.mjs';
import {extractBrokerStartUrl} from './live/broker-url.mjs';
import {buildCommandPlans, commandFileContents} from './live/commands.mjs';
import {readRecordingConfig} from './live/config.mjs';
import {buildLiveOperatorScript} from './live/operator-script.mjs';
import {inspectPublicArtifact} from './live/public-artifact.mjs';
import {
  probeVideo,
  sha256File,
  startScreenCapture,
  stopScreenCapture,
  uniqueTakePath,
  verifyUsableDuration,
} from './live/recording.mjs';
import {
  readRecordingState,
  updateTakeState,
  writeRecordingState,
} from './live/state.mjs';

const APPLESCRIPT = fromToolRoot('scripts/macos/recording-director.applescript');
const REQUIREMENTS = captureRequirements(scenes);
const CAPTURE_IDS = REQUIREMENTS.map(item => item.id);

function printHelp() {
  process.stderr.write(`Real OAuth verification recording director

Usage:
  node scripts/record-live.mjs --config recording.local.json --dry-run
  node scripts/record-live.mjs --config recording.local.json --preflight [--online] [--check-capture]
  node scripts/record-live.mjs --config recording.local.json --script [--output .work/LIVE_VIDEO_SCRIPT.md]
  node scripts/record-live.mjs --config recording.local.json --record <capture-id> [--retake]
  node scripts/record-live.mjs --config recording.local.json --sync-project
  node scripts/record-live.mjs --config recording.local.json --status

Authentic recording requires macOS, true operator confirmations, a post-scope-change
public release, and a reachable production broker. Login, MFA, consent, mailbox
writes, and revocation always remain manual.
`);
}

function commandExists(command) {
  const result = spawnSync('/usr/bin/which', [command], {stdio: 'ignore'});
  return result.status === 0;
}

function runAppleScript(action, argument) {
  const args = [APPLESCRIPT, action];
  if (argument !== undefined) args.push(argument);
  const result = spawnSync('/usr/bin/osascript', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`AppleScript ${action} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function writeCommandFile(config, name, lines) {
  const directory = resolve(config.workDirectory.absolute, 'commands');
  mkdirSync(directory, {recursive: true});
  const path = resolve(directory, `${name}.zsh`);
  const local = relative(config.workDirectory.absolute, path);
  if (local.startsWith('..')) throw new Error('Unsafe command file path');
  writeFileSync(path, commandFileContents(lines), {mode: 0o700});
  chmodSync(path, 0o700);
  return path;
}

function runVisiblePlan(config, name, lines) {
  const path = writeCommandFile(config, name, lines);
  runAppleScript('terminal-file', path);
}

async function waitForEnter(rl, message) {
  await rl.question(`${message}\nPress Return to continue: `);
}

async function requirePhrase(rl, message, phrase) {
  const answer = (await rl.question(`${message}\nType ${phrase} to continue: `)).trim();
  if (answer !== phrase) throw new Error(`Operator did not confirm ${phrase}`);
}

async function waitForBrokerUrl({timeoutMs = 30_000} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const contents = runAppleScript('terminal-contents');
      return extractBrokerStartUrl(contents);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  throw lastError ?? new Error('Timed out waiting for broker URL');
}

async function checkBroker(baseUrl) {
  const response = await fetch(`${baseUrl}/api/start`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 500) {
    throw new Error(`Production broker readiness check returned HTTP ${response.status}`);
  }
  return response.status;
}

async function disposableCaptureCheck(config) {
  const path = resolve(config.workDirectory.absolute, 'permission-check.mov');
  rmSync(path, {force: true});
  mkdirSync(config.workDirectory.absolute, {recursive: true});
  const result = spawnSync(
    '/usr/sbin/screencapture',
    ['-v', '-V1', `-D${config.display}`, path],
    {encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000},
  );
  try {
    if (result.error) throw result.error;
    if (result.status !== 0 || !existsSync(path)) {
      throw new Error(
        'Disposable capture failed. Grant Screen & System Audio Recording permission to Terminal/osascript, then relaunch it.',
      );
    }
    probeVideo(path);
  } finally {
    rmSync(path, {force: true});
  }
}

export async function runRecordingPreflight(
  config,
  {online = false, checkCapture = false, requireConfirmations = false} = {},
) {
  const errors = [];
  const warnings = [];
  if (config.exampleOnly && (online || requireConfirmations)) {
    errors.push('recording configuration is still marked exampleOnly; replace its values and set exampleOnly to false');
  }
  if (process.platform !== 'darwin') {
    errors.push('Authentic recording requires macOS');
  }
  for (const command of ['osascript', 'screencapture', 'ffprobe', 'jq', 'npm', 'tar']) {
    if (!commandExists(command)) errors.push(`Required command not found: ${command}`);
  }
  if (requireConfirmations) {
    for (const [key, value] of Object.entries(config.operatorConfirmations)) {
      if (value !== true) errors.push(`Operator confirmation is still false: ${key}`);
    }
  }
  if (online && errors.length === 0) {
    try {
      const inspected = inspectPublicArtifact(config.packageVersion);
      warnings.push(`Verified public Gmail provider ${inspected.gmailProviderVersion}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const status = await checkBroker(config.brokerUrl);
      warnings.push(`Production broker route responded with expected non-5xx HTTP ${status}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (checkCapture && errors.length === 0) {
    try {
      await disposableCaptureCheck(config);
      warnings.push('Disposable screen-recording permission check passed');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {errors, warnings};
}

function formatPreflight(result) {
  const lines = ['Live recording preflight'];
  for (const warning of result.warnings) lines.push(`OK    ${warning}`);
  for (const error of result.errors) lines.push(`ERROR ${error}`);
  lines.push(result.errors.length === 0 ? 'PASS' : `FAIL (${result.errors.length} errors)`);
  return lines.join('\n');
}

export function buildDryRun(config) {
  const script = buildLiveOperatorScript(config);
  const statePath = relative(toolRoot, resolve(config.workDirectory.absolute, 'recording-state.json'));
  return [
    'DRY RUN — no applications opened, recordings started, authentication attempted, or mailbox state changed.',
    '',
    `Capture order: ${CAPTURE_IDS.join(' → ')}`,
    `State: ${statePath}`,
    '',
    script,
  ].join('\n');
}

export function syncAcceptedTakes(config, state) {
  const project = JSON.parse(
    readFileSync(fromToolRoot('project.example.json'), 'utf8'),
  );
  for (const captureId of CAPTURE_IDS) {
    const accepted = state.captures[captureId]?.acceptedTake;
    if (!accepted?.file) continue;
    project.captures[captureId] = {
      file: accepted.file,
      kind: 'video',
    };
  }
  return project;
}

async function performShot(config, captureId, rl) {
  const plans = buildCommandPlans(config);
  switch (captureId) {
    case 'identity':
      runAppleScript('open-url', 'https://usejunior.com/products/email-agent-mcp');
      await waitForEnter(rl, 'Show the public product identity, privacy link, and Google-data section.');
      break;
    case 'auth-platform':
      runAppleScript('open-url', 'https://console.cloud.google.com/auth/clients');
      await waitForEnter(rl, 'Show the sole Web client and client ID, then Data Access with the exact scope and two selected features. Never reveal the client secret.');
      break;
    case 'configure':
      runVisiblePlan(config, 'configure', plans.configure);
      await waitForEnter(rl, 'Wait until the released version and production broker URL are visible. Leave configure running.');
      break;
    case 'oauth-consent': {
      const brokerUrl = await waitForBrokerUrl();
      runAppleScript('open-url', brokerUrl);
      await waitForEnter(rl, 'Manually complete the full English Google flow. If a password or MFA prompt appears, abort and prepare an already signed-in clean profile; never enter secrets on camera. Continue only after the browser return and Terminal Connected result are visible.');
      break;
    }
    case 'connected':
      runVisiblePlan(config, 'connected', plans.connected);
      await waitForEnter(rl, 'Wait for status to show the dedicated Gmail mailbox. Do not open token files.');
      break;
    case 'read':
      runVisiblePlan(config, 'read', plans.read);
      await waitForEnter(rl, 'Wait for list, search, read, and thread output to complete.');
      break;
    case 'send-reply':
      await requirePhrase(
        rl,
        `This will send one synthetic message only to ${config.reviewMailbox}.`,
        'SEND',
      );
      runVisiblePlan(config, 'send', plans.send);
      await waitForEnter(rl, 'Wait for the synthetic self-send to complete.');
      runAppleScript('open-url', 'https://mail.google.com/');
      await waitForEnter(rl, 'Show the synthetic message in Gmail.');
      await requirePhrase(
        rl,
        'This will send one synthetic threaded reply with reply_all set to false.',
        'REPLY',
      );
      runVisiblePlan(config, 'reply', plans.reply);
      await waitForEnter(rl, 'Wait for reply_to_email and get_thread to complete.');
      runAppleScript('open-url', 'https://mail.google.com/');
      await waitForEnter(rl, 'Refresh Gmail and show the resulting synthetic thread.');
      break;
    case 'revoke':
      runAppleScript(
        'open-url',
        'https://github.com/UseJunior/email-agent-mcp/#disconnect-gmail-and-revoke-access',
      );
      await waitForEnter(rl, 'Show the local credential-removal instructions without opening token files.');
      runAppleScript('open-url', 'https://myaccount.google.com/connections');
      await waitForEnter(rl, 'Manually revoke Email Agent MCP access and show the completion state.');
      break;
    default:
      throw new Error(`Unknown capture ID: ${captureId}`);
  }
}

async function recordCapture(config, captureId, {retake = false} = {}) {
  const requirement = REQUIREMENTS.find(item => item.id === captureId);
  if (!requirement) throw new Error(`Unknown capture ID: ${captureId}`);
  const statePath = resolve(config.workDirectory.absolute, 'recording-state.json');
  const state = readRecordingState(statePath, CAPTURE_IDS);
  if (state.captures[captureId].status === 'accepted' && !retake) {
    throw new Error(`${captureId} already has an accepted take; pass --retake to record another`);
  }

  const rl = createInterface({input: process.stdin, output: process.stderr});
  const output = uniqueTakePath(config.captureDirectory.absolute, captureId);
  let child;
  try {
    await waitForEnter(
      rl,
      `Ready to record ${captureId} to ${relative(toolRoot, output)}. Ensure the selected display is clean.`,
    );
    updateTakeState(state, captureId, {status: 'recording', currentTake: relative(toolRoot, output)});
    writeRecordingState(statePath, state);
    child = startScreenCapture({
      output,
      display: config.display,
      maximumTakeSeconds: config.maximumTakeSeconds,
    });
    child.stderr?.on('data', () => undefined);
    await new Promise((resolvePromise, reject) => {
      child.once('spawn', resolvePromise);
      child.once('error', reject);
    });
    await performShot(config, captureId, rl);
    await stopScreenCapture(child);
    child = undefined;

    const {durationMs} = probeVideo(output);
    verifyUsableDuration({
      durationMs,
      requiredDurationMs: requirement.requiredDurationMs,
    });
    const metadata = {
      file: relative(toolRoot, output),
      durationMs: Math.floor(durationMs),
      sha256: sha256File(output),
    };
    updateTakeState(state, captureId, {
      status: 'recorded',
      currentTake: null,
      latestTake: metadata,
    });
    writeRecordingState(statePath, state);

    runAppleScript('review-capture', output);
    const answer = (await rl.question('Accept this take after reviewing it? Type yes to accept: ')).trim().toLowerCase();
    if (answer === 'yes') {
      updateTakeState(state, captureId, {
        status: 'accepted',
        acceptedTake: metadata,
      });
      writeRecordingState(statePath, state);
      process.stderr.write(`Accepted ${captureId}: ${metadata.file}\n`);
    } else {
      process.stderr.write(`Take retained but not accepted: ${metadata.file}\n`);
    }
  } catch (error) {
    if (child) await stopScreenCapture(child).catch(() => undefined);
    updateTakeState(state, captureId, {
      status: 'failed',
      currentTake: null,
      failure: error instanceof Error ? error.message : String(error),
    });
    writeRecordingState(statePath, state);
    throw error;
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }
  const configArg = args.config === true || args.config === undefined
    ? 'recording.local.json'
    : args.config;
  const {config} = readRecordingConfig(configArg);

  if (args['dry-run']) {
    process.stderr.write(`${buildDryRun(config)}\n`);
    return;
  }
  if (args.script) {
    const outputArg = args.output === true || args.output === undefined
      ? '.work/LIVE_VIDEO_SCRIPT.md'
      : args.output;
    const output = fromToolRoot(outputArg);
    const local = relative(toolRoot, output);
    if (local.startsWith('..') || (!local.startsWith('.work/') && local !== '.work')) {
      throw new Error('Generated live script output must stay below .work');
    }
    mkdirSync(resolve(output, '..'), {recursive: true});
    writeFileSync(output, buildLiveOperatorScript(config));
    process.stderr.write(`Wrote ${local}\n`);
    return;
  }
  if (args.status) {
    const state = readRecordingState(
      resolve(config.workDirectory.absolute, 'recording-state.json'),
      CAPTURE_IDS,
    );
    for (const id of CAPTURE_IDS) {
      process.stderr.write(`${id.padEnd(16)} ${state.captures[id].status}\n`);
    }
    return;
  }
  if (args['sync-project']) {
    const state = readRecordingState(
      resolve(config.workDirectory.absolute, 'recording-state.json'),
      CAPTURE_IDS,
    );
    const project = syncAcceptedTakes(config, state);
    const output = fromToolRoot('project.local.json');
    writeFileSync(output, `${JSON.stringify(project, null, 2)}\n`, {mode: 0o600});
    process.stderr.write('Wrote project.local.json with accepted takes; all final attestations remain false.\n');
    return;
  }
  if (args.preflight) {
    const result = await runRecordingPreflight(config, {
      online: Boolean(args.online),
      checkCapture: Boolean(args['check-capture']),
      requireConfirmations: Boolean(args.online),
    });
    process.stderr.write(`${formatPreflight(result)}\n`);
    if (result.errors.length > 0) process.exitCode = 1;
    return;
  }
  if (typeof args.record === 'string') {
    const result = await runRecordingPreflight(config, {
      online: true,
      checkCapture: true,
      requireConfirmations: true,
    });
    process.stderr.write(`${formatPreflight(result)}\n`);
    if (result.errors.length > 0) {
      process.exitCode = 1;
      return;
    }
    await recordCapture(config, args.record, {retake: Boolean(args.retake)});
    return;
  }
  printHelp();
  process.exitCode = 2;
}

const invokedPath = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedPath) {
  main().catch(error => {
    process.stderr.write(`Live recording director failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
