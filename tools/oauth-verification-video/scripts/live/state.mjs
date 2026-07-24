import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {dirname} from 'node:path';

export function emptyRecordingState(captureIds) {
  return {
    version: 1,
    captures: Object.fromEntries(
      captureIds.map(id => [id, {status: 'pending', acceptedTake: null}]),
    ),
  };
}

export function readRecordingState(path, captureIds) {
  if (!existsSync(path)) return emptyRecordingState(captureIds);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state?.version !== 1 || !state.captures || typeof state.captures !== 'object') {
    throw new Error('Recording state has an unsupported shape');
  }
  for (const id of captureIds) {
    state.captures[id] ??= {status: 'pending', acceptedTake: null};
  }
  return state;
}

export function writeRecordingState(path, state) {
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, path);
}

export function updateTakeState(state, captureId, update) {
  if (!state.captures[captureId]) throw new Error(`Unknown capture ID: ${captureId}`);
  const allowed = new Set(['pending', 'recording', 'recorded', 'failed', 'accepted']);
  if (!allowed.has(update.status)) throw new Error(`Invalid take status: ${update.status}`);
  state.captures[captureId] = {
    ...state.captures[captureId],
    ...update,
  };
  return state;
}
