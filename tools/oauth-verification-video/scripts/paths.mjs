import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function fromToolRoot(path) {
  return resolve(toolRoot, path);
}
