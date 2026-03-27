// Email watcher — monitors mailboxes and POSTs to wake URL

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
 * Build wake payload for a new email.
 */
export function buildWakePayload(
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
