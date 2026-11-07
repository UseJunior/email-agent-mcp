// Send allowlist — gates ALL outbound email (sends AND replies)
// Default: EMPTY — blocks all outbound until explicitly configured
// Loaded at startup from config. No MCP tool to modify.

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AllowlistConfig } from '../actions/registry.js';
import type { RateLimiter, RateReservationResult, ReservationRateLimiter } from '../actions/registry.js';
import { terminalRateReservation } from './rate-reservation.js';

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
export class SendRateLimiter implements RateLimiter, ReservationRateLimiter {
  private readonly entries = new Set<{ consumedAt?: number }>();
  private maxPerWindow: number;
  private windowMs: number;

  // performance.now is monotonic: wall-clock corrections cannot reset quota.
  // Injected clocks must also report monotonic elapsed milliseconds.
  constructor(maxPerWindow = 50, windowMs = 3600000, private readonly now: () => number = () => performance.now()) {
    if (!Number.isSafeInteger(maxPerWindow) || maxPerWindow < 0) throw new RangeError('Invalid rate capacity');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('Invalid rate window');
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  /** Atomically includes live reservations across every action on this instance. */
  tryReserve(action: string): RateReservationResult {
    const check = this.checkLimit(action);
    if (!check.allowed) return { allowed: false, retryAfter: check.retryAfter };
    const entry: { consumedAt?: number } = {};
    this.entries.add(entry);
    return {
      allowed: true,
      lease: terminalRateReservation(
        () => { this.entries.delete(entry); },
        () => { entry.consumedAt = this.now(); },
      ),
    };
  }

  /** @deprecated Observation only; use tryReserve to prevent check/record races. */
  checkLimit(_action: string): { allowed: boolean; retryAfter?: number } {
    this.cleanup();
    if (this.entries.size >= this.maxPerWindow) {
      // Live reservations never expire. The window is polling guidance when
      // capacity is zero or held entirely by unsettled requests.
      let oldest = Infinity;
      for (const entry of this.entries) oldest = Math.min(oldest, entry.consumedAt ?? Infinity);
      const retryAfter = Math.max(1, Math.ceil((Number.isFinite(oldest) ? oldest + this.windowMs - this.now() : this.windowMs) / 1000));
      return { allowed: false, retryAfter };
    }
    return { allowed: true };
  }

  /** @deprecated Unconditional legacy accounting; prefer a reservation lease. */
  recordUsage(_action: string): void {
    this.cleanup();
    this.entries.add({ consumedAt: this.now() });
  }

  private cleanup(): void {
    const cutoff = this.now() - this.windowMs;
    for (const entry of this.entries) {
      if (entry.consumedAt !== undefined && entry.consumedAt <= cutoff) this.entries.delete(entry);
    }
  }
}
