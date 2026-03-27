// Receive allowlist — controls which inbound emails trigger the watcher
// Default: accept all (wildcard *) — agent can READ any email
// Loaded at startup from config. No MCP tool to modify.

import type { AllowlistConfig } from '../actions/registry.js';

/**
 * Check if an inbound sender is allowed by the receive allowlist.
 * Default (no config): accept all.
 */
export function isAllowedSender(
  email: string,
  allowlist: AllowlistConfig | undefined,
): boolean {
  // Default: accept all
  if (!allowlist || allowlist.entries.length === 0) {
    return true;
  }

  const lowerEmail = email.toLowerCase();

  for (const entry of allowlist.entries) {
    const lowerEntry = entry.toLowerCase();

    if (lowerEntry === '*') return true;

    if (lowerEntry.startsWith('*@')) {
      const domain = lowerEntry.slice(2);
      if (lowerEmail.endsWith(`@${domain}`)) return true;
    } else {
      if (lowerEmail === lowerEntry) return true;
    }
  }

  return false;
}

/**
 * Load receive allowlist from a JSON file path.
 */
export async function loadReceiveAllowlist(filePath?: string): Promise<AllowlistConfig | undefined> {
  if (!filePath) return undefined;

  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as { entries?: string[] };
    return { entries: data.entries ?? [] };
  } catch {
    return undefined;
  }
}

/**
 * Get the receive allowlist file path from environment or config.
 */
export function getReceiveAllowlistPath(): string | undefined {
  return process.env['AGENT_EMAIL_RECEIVE_ALLOWLIST'];
}

// Delete policy enforcement
export interface DeletePolicy {
  enabled: boolean;
  hardDeleteAllowed: boolean;
}

export function checkDeletePolicy(
  policy: DeletePolicy | undefined,
  userExplicitlyRequestedDeletion: boolean,
  hardDelete: boolean,
): string | undefined {
  if (!policy || !policy.enabled) {
    return 'Email deletion is disabled. Enable in configuration if needed.';
  }

  if (!userExplicitlyRequestedDeletion) {
    return 'user_explicitly_requested_deletion must be true to delete emails';
  }

  if (hardDelete && !policy.hardDeleteAllowed) {
    return 'Hard delete is not allowed in current configuration';
  }

  return undefined;
}

// Anti-spoofing check
export interface AuthenticationResult {
  spf?: 'pass' | 'fail' | 'softfail' | 'none';
  dkim?: 'pass' | 'fail' | 'none';
  dmarc?: 'pass' | 'fail' | 'none';
  isInternal?: boolean;
}

export type SpoofCheckStrictness = 'strict' | 'relaxed' | 'off';

export function checkAntiSpoofing(
  authResult: AuthenticationResult,
  strictness: SpoofCheckStrictness = 'relaxed',
): { passed: boolean; reason?: string } {
  if (strictness === 'off') {
    return { passed: true };
  }

  // Internal emails always pass
  if (authResult.isInternal) {
    return { passed: true };
  }

  if (strictness === 'strict') {
    // Require both SPF and DKIM pass
    if (authResult.spf !== 'pass' || authResult.dkim !== 'pass') {
      return {
        passed: false,
        reason: `Anti-spoofing check failed (strict): SPF=${authResult.spf ?? 'none'}, DKIM=${authResult.dkim ?? 'none'}`,
      };
    }
    return { passed: true };
  }

  // Relaxed: require either SPF or DKIM pass
  if (authResult.spf !== 'pass' && authResult.dkim !== 'pass') {
    return {
      passed: false,
      reason: `Anti-spoofing check failed (relaxed): SPF=${authResult.spf ?? 'none'}, DKIM=${authResult.dkim ?? 'none'}`,
    };
  }
  return { passed: true };
}
