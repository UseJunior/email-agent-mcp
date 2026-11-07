// Email watcher — monitors mailboxes and POSTs to wake URL
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EmailMessage, EmailAddress } from '@usejunior/email-core';
import { MailboxLease } from './mailbox-lease.js';

export { MailboxLease } from './mailbox-lease.js';

const EMAIL_AGENT_MCP_HOME = process.env['EMAIL_AGENT_MCP_HOME'] ?? join(homedir(), '.email-agent-mcp');
const STATE_DIR = join(EMAIL_AGENT_MCP_HOME, 'state');

export interface WatcherConfig {
  wakeUrl: string;
  token?: string; // OPENCLAW_HOOKS_TOKEN
  pollIntervalMs?: number; // Default 30s
  mailboxes: WatchedMailbox[];
}

export interface WatchedMailbox {
  name: string;
  providerType: 'microsoft' | 'gmail';
  mode: 'polling' | 'webhook' | 'pubsub';
}

export interface WakePayload {
  text: string;
  mode: 'now';
}

/** Persisted delta state for a mailbox */
export interface DeltaState {
  deltaLink: string;
  lastUpdated: string;
}

// Deduplication — track processed message IDs
const processedMessages = new Set<string>();

/**
 * Check if a message has already been processed (dedup).
 */
export function isProcessed(messageId: string): boolean {
  return processedMessages.has(messageId);
}

/**
 * Mark a message as processed.
 */
export function markProcessed(messageId: string): void {
  processedMessages.add(messageId);
  // Limit memory usage — evict old entries
  if (processedMessages.size > 10000) {
    const entries = [...processedMessages];
    for (let i = 0; i < 5000; i++) {
      processedMessages.delete(entries[i]!);
    }
  }
}

/**
 * Reset processed messages (for testing).
 */
export function resetProcessed(): void {
  processedMessages.clear();
}

/**
 * Format a recipient list as "name <email>" or just "email" if no name.
 */
function formatRecipient(addr: EmailAddress): string {
  if (addr.name) return `${addr.name} <${addr.email}>`;
  return addr.email;
}

/**
 * Build wake payload for a new email.
 * Text-only format with full recipient info for OpenClaw /hooks/wake.
 *
 * Format:
 *   New email to {receiving_email} from {sender_name} <{sender_email}>: {subject}
 *   To: {to_list}
 *   Cc: {cc_list}         (omitted if no cc)
 *   Attachments: yes      (omitted if no attachments)
 */
export function buildWakePayload(
  receivingEmail: string,
  message: EmailMessage,
): WakePayload {
  const senderFormatted = formatRecipient(message.from);
  const toList = message.to.map(r => r.email).join(', ');

  let text = `New email to ${receivingEmail} from ${senderFormatted}: ${message.subject}`;
  text += `\nTo: ${toList}`;

  if (message.cc && message.cc.length > 0) {
    const ccList = message.cc.map(r => r.email).join(', ');
    text += `\nCc: ${ccList}`;
  }

  if (message.hasAttachments) {
    text += '\nAttachments: yes';
  }

  return { text, mode: 'now' };
}

/**
 * Legacy buildWakePayload for backward compatibility with old tests.
 * @deprecated Use the new signature with EmailMessage instead.
 */
export function buildWakePayloadLegacy(
  mailboxName: string,
  senderEmail: string,
  subject: string,
): WakePayload {
  return {
    text: `[${mailboxName}] New email from ${senderEmail}: ${subject}`,
    mode: 'now',
  };
}

/**
 * Send authenticated wake POST.
 */
export async function sendWake(
  wakeUrl: string,
  payload: WakePayload,
  token?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(wakeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return { success: false, error: `Wake POST failed: ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Wake POST failed',
    };
  }
}

/**
 * Get the wake token from environment or config.
 */
export function getWakeToken(): string | undefined {
  return process.env['OPENCLAW_HOOKS_TOKEN'];
}

/**
 * Determine watch mode based on provider and config.
 */
export function getWatchMode(
  providerType: string,
  hasPublicUrl: boolean,
  hasPubSub: boolean,
): 'polling' | 'webhook' | 'pubsub' {
  if (providerType === 'microsoft') {
    return hasPublicUrl ? 'webhook' : 'polling';
  }
  if (providerType === 'gmail') {
    return hasPubSub ? 'pubsub' : 'polling';
  }
  return 'polling';
}

/**
 * Check if a subscription needs renewal.
 */
export function needsSubscriptionRenewal(
  expiresAt: string,
  bufferMs = 3600000, // 1 hour
): boolean {
  return Date.now() >= new Date(expiresAt).getTime() - bufferMs;
}

// ─── Delta State Persistence ──────────────────────────────────────────

/**
 * Get the delta state file path for a mailbox.
 */
export function getDeltaStatePath(mailboxSafeKey: string): string {
  return join(STATE_DIR, `${mailboxSafeKey}.delta.json`);
}

/**
 * Load persisted delta state for a mailbox.
 * Returns null if no saved state exists.
 */
export async function loadDeltaState(mailboxSafeKey: string): Promise<DeltaState | null> {
  try {
    const content = await readFile(getDeltaStatePath(mailboxSafeKey), 'utf-8');
    return JSON.parse(content) as DeltaState;
  } catch {
    return null;
  }
}

/**
 * Save delta state for a mailbox.
 */
export async function saveDeltaState(mailboxSafeKey: string, state: DeltaState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(getDeltaStatePath(mailboxSafeKey), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Delete delta state for a mailbox (used on 410 Gone resync).
 */
export async function deleteDeltaState(mailboxSafeKey: string): Promise<void> {
  try {
    await unlink(getDeltaStatePath(mailboxSafeKey));
  } catch {
    // File may not exist — that's fine
  }
}

// ─── Lock File Management ─────────────────────────────────────────────

/**
 * Get the lock file path for a mailbox.
 */
export function getLockFilePath(mailboxSafeKey: string): string {
  return join(STATE_DIR, `${mailboxSafeKey}.watcher.lock`);
}

/**
 * Acquire a lock file for a mailbox.
 * Returns true if lock was acquired, false if already locked by another process.
 */
const heldLeases = new Map<string, MailboxLease>();
const acquiringLeases = new Set<string>();

export async function acquireMailboxLease(mailboxSafeKey: string): Promise<MailboxLease | null> {
  const previous = heldLeases.get(mailboxSafeKey);
  if (previous?.released && heldLeases.get(mailboxSafeKey) === previous) heldLeases.delete(mailboxSafeKey);
  if (heldLeases.has(mailboxSafeKey) || acquiringLeases.has(mailboxSafeKey)) return null;
  acquiringLeases.add(mailboxSafeKey);
  try {
    const lease = await MailboxLease.acquire(STATE_DIR, mailboxSafeKey);
    if (lease) heldLeases.set(mailboxSafeKey, lease);
    return lease;
  } finally {
    acquiringLeases.delete(mailboxSafeKey);
  }
}

/** @deprecated Use acquireMailboxLease and retain its ownership handle. */
export async function acquireLock(mailboxSafeKey: string): Promise<boolean> {
  return (await acquireMailboxLease(mailboxSafeKey)) !== null;
}

/**
 * Release a lock file for a mailbox.
 */
export async function releaseLock(mailboxSafeKey: string): Promise<void> {
  const lease = heldLeases.get(mailboxSafeKey);
  if (!lease) return;
  await lease.release();
  if (heldLeases.get(mailboxSafeKey) === lease) heldLeases.delete(mailboxSafeKey);
}

/**
 * Release all lock files owned by this process.
 */
export async function releaseAllLocks(): Promise<void> {
  await Promise.all([...heldLeases.keys()].map(releaseLock));
}
