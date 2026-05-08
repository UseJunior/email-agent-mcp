// Receive allowlist — controls which inbound emails trigger the watcher
// Default: accept all (wildcard *) — agent can READ any email
// Loaded at startup from config. No MCP tool to modify.

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AllowlistConfig } from '../actions/registry.js';

function getAgentEmailHome(): string {
  return process.env['EMAIL_AGENT_MCP_HOME']
    ?? join(homedir(), '.email-agent-mcp');
}

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
export function getReceiveAllowlistPath(): string {
  return process.env['AGENT_EMAIL_RECEIVE_ALLOWLIST']
    ?? join(getAgentEmailHome(), 'receive-allowlist.json');
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
  if (!policy || policy.enabled !== true) {
    return 'Email deletion is disabled. Set AGENT_EMAIL_DELETE_ENABLED=true in the email-agent-mcp process environment to enable.';
  }

  if (userExplicitlyRequestedDeletion !== true) {
    return 'user_explicitly_requested_deletion must be true to delete emails';
  }

  if (hardDelete && policy.hardDeleteAllowed !== true) {
    return 'Hard delete is not allowed. Set AGENT_EMAIL_HARD_DELETE_ENABLED=true in the email-agent-mcp process environment to enable.';
  }

  return undefined;
}

/**
 * Resolve the delete policy from environment variables. Strict: only the
 * literal string 'true' enables a gate; all other values leave it disabled.
 * Returns undefined when deletion is not enabled.
 *
 * Side effects: emits stderr warnings via `onWarn` for misconfigured env state
 * (unsupported non-empty values, or hard-delete enabled without delete enabled)
 * so silent typos don't strand operators on the disabled fallback.
 */
export function getDeletePolicyFromEnv(
  onWarn: (msg: string) => void = (msg) => { console.error(msg); },
): DeletePolicy | undefined {
  const rawDelete = process.env['AGENT_EMAIL_DELETE_ENABLED'];
  const rawHard = process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'];

  if (rawDelete !== undefined && rawDelete !== '' && rawDelete !== 'true') {
    onWarn(`[email-agent-mcp] WARNING: AGENT_EMAIL_DELETE_ENABLED='${rawDelete}' is not 'true' — deletion remains disabled.`);
  }
  if (rawHard !== undefined && rawHard !== '' && rawHard !== 'true') {
    onWarn(`[email-agent-mcp] WARNING: AGENT_EMAIL_HARD_DELETE_ENABLED='${rawHard}' is not 'true' — hard delete remains disabled.`);
  }

  if (rawDelete !== 'true') {
    if (rawHard === 'true') {
      onWarn('[email-agent-mcp] WARNING: AGENT_EMAIL_HARD_DELETE_ENABLED=true has no effect without AGENT_EMAIL_DELETE_ENABLED=true.');
    }
    return undefined;
  }
  return { enabled: true, hardDeleteAllowed: rawHard === 'true' };
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
