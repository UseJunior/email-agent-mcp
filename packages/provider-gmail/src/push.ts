// Gmail push notification support — Pub/Sub and history.list polling

export interface GmailWatchConfig {
  topicName?: string; // Pub/Sub topic (if not set, use polling)
  labelIds?: string[];
  pollIntervalMs?: number; // Default 30s
}

export interface WatchRegistration {
  historyId: string;
  expiration: string; // ISO timestamp, ~7 days
}

/**
 * Register for Gmail Pub/Sub push notifications.
 * Auto-renews every 7 days.
 */
export async function registerWatch(
  client: { watch(opts: { topicName: string; labelIds: string[] }): Promise<WatchRegistration> },
  config: GmailWatchConfig,
): Promise<WatchRegistration> {
  if (!config.topicName) {
    throw new Error('Pub/Sub topic required for push mode');
  }
  return client.watch({
    topicName: config.topicName,
    labelIds: config.labelIds ?? ['INBOX'],
  });
}

/**
 * Check if watch registration needs renewal (approaching 7-day expiry).
 */
export function needsRenewal(expiration: string, bufferMs = 3600000): boolean {
  return Date.now() >= new Date(expiration).getTime() - bufferMs;
}

/**
 * History-based polling for when Pub/Sub is not configured.
 */
export async function pollHistory(
  client: { listHistory(startHistoryId: string): Promise<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; historyId: string }> },
  startHistoryId: string,
): Promise<{ newMessageIds: string[]; nextHistoryId: string }> {
  const response = await client.listHistory(startHistoryId);
  const newMessageIds: string[] = [];

  if (response.history) {
    for (const entry of response.history) {
      if (entry.messagesAdded) {
        for (const added of entry.messagesAdded) {
          newMessageIds.push(added.message.id);
        }
      }
    }
  }

  return {
    newMessageIds,
    nextHistoryId: response.historyId,
  };
}
