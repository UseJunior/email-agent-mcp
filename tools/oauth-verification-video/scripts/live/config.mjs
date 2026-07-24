import {readFileSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {toolRoot} from '../paths.mjs';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const MAILBOX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_SUBJECT = /^[A-Za-z0-9 .:_-]{1,120}$/;
const REQUIRED_CONFIRMATIONS = [
  'dedicatedEmptyMailbox',
  'cleanEnglishBrowserProfile',
  'focusModeEnabled',
  'previousGrantRevoked',
  'soleProductionWebClient',
];

function localPath(value, label, requiredPrefix) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) {
    throw new Error(`${label} must be a relative path`);
  }
  const resolved = resolve(toolRoot, value);
  const local = relative(toolRoot, resolved);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`${label} must stay inside tools/oauth-verification-video`);
  }
  const normalized = local.split(sep).join('/');
  if (normalized !== requiredPrefix && !normalized.startsWith(`${requiredPrefix}/`)) {
    throw new Error(`${label} must be ${requiredPrefix} or a path below it`);
  }
  return {relative: normalized, absolute: resolved};
}

export function validateRecordingConfig(input, {requireConfirmations = false} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Recording configuration must be a JSON object');
  }
  if (!EXACT_VERSION.test(input.packageVersion ?? '')) {
    throw new Error('packageVersion must be an exact published version such as 0.1.10; latest and ranges are forbidden');
  }
  if (!MAILBOX.test(input.reviewMailbox ?? '')) {
    throw new Error('reviewMailbox must be the dedicated test mailbox email address');
  }
  const broker = new URL(input.brokerUrl ?? '');
  if (broker.origin !== 'https://oauth.usejunior.com' || broker.pathname !== '/') {
    throw new Error('brokerUrl must be exactly https://oauth.usejunior.com');
  }
  if (!Number.isInteger(input.display) || input.display < 1) {
    throw new Error('display must be a positive integer');
  }
  if (
    !Number.isInteger(input.maximumTakeSeconds)
    || input.maximumTakeSeconds < 30
    || input.maximumTakeSeconds > 900
  ) {
    throw new Error('maximumTakeSeconds must be an integer from 30 through 900');
  }
  for (const key of ['seedSubject', 'writeSubject']) {
    if (!SAFE_SUBJECT.test(input[key] ?? '')) {
      throw new Error(`${key} must contain only safe display text and be 1-120 characters`);
    }
  }

  const confirmations = input.operatorConfirmations ?? {};
  for (const key of REQUIRED_CONFIRMATIONS) {
    if (typeof confirmations[key] !== 'boolean') {
      throw new Error(`operatorConfirmations.${key} must be true or false`);
    }
    if (requireConfirmations && confirmations[key] !== true) {
      throw new Error(`Recording blocked until operatorConfirmations.${key} is true`);
    }
  }

  const emailAgentHome = localPath(input.emailAgentHome, 'emailAgentHome', '.work');
  const captureDirectory = localPath(input.captureDirectory, 'captureDirectory', 'captures');
  const workDirectory = localPath(input.workDirectory, 'workDirectory', '.work');

  return {
    exampleOnly: input.exampleOnly === true,
    packageVersion: input.packageVersion,
    packageSpec: `email-agent-mcp@${input.packageVersion}`,
    reviewMailbox: input.reviewMailbox.toLowerCase(),
    brokerUrl: broker.origin,
    display: input.display,
    maximumTakeSeconds: input.maximumTakeSeconds,
    emailAgentHome,
    captureDirectory,
    workDirectory,
    seedSubject: input.seedSubject,
    writeSubject: input.writeSubject,
    operatorConfirmations: Object.fromEntries(
      REQUIRED_CONFIRMATIONS.map(key => [key, confirmations[key]]),
    ),
  };
}

export function readRecordingConfig(
  configArg = 'recording.local.json',
  options,
) {
  const path = resolve(toolRoot, configArg);
  const local = relative(toolRoot, path);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error('Recording configuration must live inside tools/oauth-verification-video');
  }
  const input = JSON.parse(readFileSync(path, 'utf8'));
  return {path, config: validateRecordingConfig(input, options)};
}

export const recordingConfirmationKeys = REQUIRED_CONFIRMATIONS;
