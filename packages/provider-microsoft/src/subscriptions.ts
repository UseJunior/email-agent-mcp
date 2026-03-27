// Graph subscription management — validation, dedup, zombie detection, health check

import type { GraphApiClient } from './email-graph-provider.js';

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
}

// Webhook deduplication — in-memory map keyed by message ID
const recentNotifications = new Map<string, number>();
const DEDUP_WINDOW_MS = 30000; // 30 seconds

/**
 * Handle Graph validation token on GET or POST.
 * Returns the token as plaintext (HTML-escaped).
 */
export function handleValidationToken(validationToken: string): { status: number; body: string; contentType: string } {
  // HTML-escape the token for safety
  const escaped = validationToken
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return {
    status: 200,
    body: escaped,
    contentType: 'text/plain',
  };
}

/**
 * Check if a notification is a duplicate (Graph sends duplicates ~9ms apart).
 */
export function isDuplicateNotification(messageId: string): boolean {
  const now = Date.now();

  // Clean up old entries
  for (const [key, timestamp] of recentNotifications) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentNotifications.delete(key);
    }
  }

  if (recentNotifications.has(messageId)) {
    return true;
  }

  recentNotifications.set(messageId, now);
  return false;
}

/**
 * Reset dedup state (for testing).
 */
export function resetDedupState(): void {
  recentNotifications.clear();
}

/**
 * Detect zombie subscription — verify it exists before renewal.
 */
export async function checkSubscriptionExists(
  client: GraphApiClient,
  subscriptionId: string,
): Promise<boolean> {
  try {
    await client.get(`/subscriptions/${subscriptionId}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Health check before creating a subscription.
 * Tests that the validation endpoint responds correctly.
 */
export async function healthCheckEndpoint(
  endpointUrl: string,
): Promise<{ healthy: boolean; error?: string }> {
  try {
    const testToken = `health-check-${Date.now()}`;
    const url = new URL(endpointUrl);
    url.searchParams.set('validationToken', testToken);

    const response = await fetch(url.toString());
    const body = await response.text();

    if (response.status !== 200) {
      return { healthy: false, error: `Endpoint returned ${response.status}` };
    }

    if (!body.includes(testToken.replace(/&/g, '&amp;'))) {
      return { healthy: false, error: 'Endpoint did not echo validation token' };
    }

    return { healthy: true };
  } catch (err) {
    return {
      healthy: false,
      error: err instanceof Error ? err.message : 'Failed to reach endpoint',
    };
  }
}

/**
 * Create a Graph subscription for inbox messages only.
 * Resource MUST be mailFolders/Inbox/messages — never bare /messages.
 */
export async function createInboxSubscription(
  client: GraphApiClient,
  userId: string,
  notificationUrl: string,
  expirationMinutes = 4230, // Max ~2.9 days for mail
): Promise<GraphSubscription> {
  const expirationDateTime = new Date(
    Date.now() + expirationMinutes * 60000,
  ).toISOString();

  const subscription = await client.post('/subscriptions', {
    changeType: 'created',
    notificationUrl,
    resource: `users/${userId}/mailFolders/Inbox/messages`,
    expirationDateTime,
  }) as unknown as GraphSubscription;

  return subscription;
}
