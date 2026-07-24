import {readFileSync} from 'node:fs';
import {relative, resolve} from 'node:path';
import {fromToolRoot, toolRoot} from './paths.mjs';

export function resolveProjectPath(projectArg = 'project.example.json') {
  const candidate = resolve(toolRoot, projectArg);
  const rel = relative(toolRoot, candidate);
  if (rel.startsWith('..')) {
    throw new Error('Project manifest must live inside tools/oauth-verification-video');
  }
  return candidate;
}

export function readProject(projectArg) {
  const path = resolveProjectPath(projectArg);
  return {
    path,
    project: JSON.parse(readFileSync(path, 'utf8')),
  };
}

export function resolveMediaPath(path) {
  return fromToolRoot(path);
}
