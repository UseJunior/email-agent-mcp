// Send allowlist — gates ALL outbound email (sends AND replies)
// Default: EMPTY — blocks all outbound until explicitly configured
// Loaded at startup from config. No MCP tool to modify.

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AllowlistConfig } from '../actions/registry.js';

function getAgentEmailHome(): string {
  return process.env['EMAIL_AGENT_MCP_HOME']
    ?? join(homedir(), '.email-agent-mcp');
}

/**
 * Check if a recipient email address is allowed by the send allowlist.
 */
export function isAllowedRecipient(
  email: string,
  allowlist: AllowlistConfig | undefined,
): boolean {
  if (!allowlist || allowlist.entries.length === 0) {
    return false;
  }

  const lowerEmail = email.toLowerCase();

  for (const entry of allowlist.entries) {
    const lowerEntry = entry.toLowerCase();

    // Universal wildcard
    if (lowerEntry === '*') return true;

    // Domain wildcard: *@domain.com
    if (lowerEntry.startsWith('*@')) {
      const domain = lowerEntry.slice(2);
      if (lowerEmail.endsWith(`@${domain}`)) return true;
    } else {
      // Exact match
      if (lowerEmail === lowerEntry) return true;
    }
  }

  return false;
}

/**
 * Load send allowlist from a JSON file path.
 */
export async function loadSendAllowlist(filePath?: string): Promise<AllowlistConfig | undefined> {
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
 * Get the send allowlist file path from environment or config.
 */
export function getSendAllowlistPath(): string {
  return process.env['AGENT_EMAIL_SEND_ALLOWLIST']
    ?? join(getAgentEmailHome(), 'send-allowlist.json');
}

/**
 * Validate all recipients against the send allowlist.
 * Returns an error message if any recipient is blocked, or undefined if all are allowed.
 */
export function checkSendAllowlist(
  recipients: string[],
  allowlist: AllowlistConfig | undefined,
): string | undefined {
  if (!allowlist || allowlist.entries.length === 0) {
    return 'Send allowlist not configured — all outbound email is disabled';
  }

  for (const recipient of recipients) {
    if (!isAllowedRecipient(recipient, allowlist)) {
      return `Recipient not in send allowlist: ${recipient}`;
    }
  }

  return undefined;
}

// Rate limiter implementation
export class SendRateLimiter {
  private timestamps: number[] = [];
  private maxPerWindow: number;
  private windowMs: number;

  constructor(maxPerWindow = 50, windowMs = 3600000) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  checkLimit(_action: string): { allowed: boolean; retryAfter?: number } {
    this.cleanup();
    if (this.timestamps.length >= this.maxPerWindow) {
      const oldest = this.timestamps[0]!;
      const retryAfter = Math.ceil((oldest + this.windowMs - Date.now()) / 1000);
      return { allowed: false, retryAfter };
    }
    return { allowed: true };
  }

  recordUsage(_action: string): void {
    this.timestamps.push(Date.now());
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter(ts => ts > cutoff);
  }
}
