import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AllowlistConfig } from '../actions/registry.js';

export type AllowlistPolicy =
  | { status: 'absent' }
  | { status: 'valid'; config: AllowlistConfig }
  | { status: 'invalid'; reason: string };

export type AllowlistInput = AllowlistConfig | AllowlistPolicy | undefined;

const AllowlistSchema = z.object({ entries: z.array(z.string()) });

/** Only ENOENT means absence. Existing but unreadable/invalid files fail closed. */
export async function loadAllowlistPolicy(filePath?: string): Promise<AllowlistPolicy> {
  if (!filePath) return { status: 'absent' };
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = AllowlistSchema.safeParse(JSON.parse(content));
    return parsed.success
      ? { status: 'valid', config: parsed.data }
      : { status: 'invalid', reason: 'Allowlist must contain an entries array of strings' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'invalid', reason: err instanceof SyntaxError ? 'Malformed allowlist JSON' : 'Cannot read allowlist file' };
  }
}

export function asAllowlistPolicy(input: AllowlistInput): AllowlistPolicy {
  if (!input) return { status: 'absent' };
  return 'status' in input ? input : { status: 'valid', config: input };
}
