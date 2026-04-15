// Shared safe-path check used by body-loader and attachment-loader.
//
// The naive approach — `candidate.startsWith(baseDir)` — has a sibling-prefix
// bug: given `baseDir=/allowed`, `candidate=/allowed-evil/foo` would pass,
// because the string "/allowed-evil/foo" literally starts with "/allowed".
// This caller uses `path.relative()` + rejection of `..`-prefixes or absolute
// results, which correctly distinguishes subdirectories from prefix-siblings.
//
// Callers should pass REALPATHS (with symlinks resolved) for both arguments,
// so this helper's answer is accurate for symlink-containing trees too.
import { relative, isAbsolute } from 'node:path';

/**
 * Return true if `candidateReal` is equal to `baseReal` or a descendant of it.
 * Both inputs should already be absolute realpaths (pass them through
 * `fs.promises.realpath` first).
 */
export function isPathInsideDir(candidateReal: string, baseReal: string): boolean {
  if (!isAbsolute(candidateReal) || !isAbsolute(baseReal)) return false;
  const rel = relative(baseReal, candidateReal);
  // An empty relative path means candidate === base (inside by definition).
  if (rel === '') return true;
  // If rel starts with '..' or is itself absolute, candidate is outside base.
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}
