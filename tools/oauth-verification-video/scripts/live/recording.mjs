import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {basename, join} from 'node:path';

function timestamp(now = new Date()) {
  return now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function uniqueTakePath(directory, captureId, now = new Date()) {
  if (!/^[a-z0-9-]+$/.test(captureId)) throw new Error(`Unsafe capture ID: ${captureId}`);
  mkdirSync(directory, {recursive: true});
  const stem = `${captureId}-take-${timestamp(now)}`;
  let candidate = join(directory, `${stem}.mov`);
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = join(directory, `${stem}-${counter}.mov`);
    counter += 1;
  }
  return candidate;
}

export function startScreenCapture({
  output,
  display,
  maximumTakeSeconds,
  executable = '/usr/sbin/screencapture',
}) {
  if (existsSync(output)) throw new Error(`Refusing to overwrite take: ${output}`);
  const child = spawn(
    executable,
    ['-v', `-V${maximumTakeSeconds}`, `-D${display}`, '-k', output],
    {stdio: ['ignore', 'ignore', 'pipe']},
  );
  return child;
}

export async function stopScreenCapture(child, {timeoutMs = 15_000} = {}) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? 0;
  child.kill('SIGINT');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Screen recording did not stop cleanly within 15 seconds'));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

export function probeVideo(path, ffprobe = 'ffprobe') {
  const result = spawnSync(
    ffprobe,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type:format=duration',
      '-of', 'json',
      path,
    ],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffprobe rejected ${basename(path)}: ${result.stderr.trim()}`);
  }
  const data = JSON.parse(result.stdout);
  if (!data.streams?.some(stream => stream.codec_type === 'video')) {
    throw new Error(`${basename(path)} contains no video stream`);
  }
  const durationMs = Number(data.format?.duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`${basename(path)} has no positive duration`);
  }
  return {durationMs};
}

export function verifyUsableDuration({durationMs, inMs = 0, requiredDurationMs}) {
  if (!Number.isFinite(inMs) || inMs < 0) throw new Error('inMs must be a non-negative number');
  const usableMs = durationMs - inMs;
  if (usableMs < requiredDurationMs) {
    throw new Error(
      `Take has ${Math.max(0, Math.floor(usableMs))}ms usable after inMs; ${requiredDurationMs}ms required`,
    );
  }
  return usableMs;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
