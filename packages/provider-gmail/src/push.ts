// Gmail push notification support — Pub/Sub and history.list polling

export interface GmailWatchConfig {
  topicName?: string; // Pub/Sub topic (if not set, use polling)
  labelIds?: string[];
  pollIntervalMs?: number; // Default 30s
}

export interface WatchRegistration {
  historyId: string;
  expiration: string; // ISO timestamp or Gmail epoch milliseconds, ~7 days
}

/**
 * Register for Gmail Pub/Sub push notifications.
 * The caller schedules renewal before expiration; this helper starts no timer.
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
  const expiresAt = /^\d+$/.test(expiration) ? Number(expiration) : Date.parse(expiration);
  if (!Number.isFinite(expiresAt) || expiresAt < 0 || !Number.isFinite(bufferMs) || bufferMs < 0) {
    throw new Error('Invalid watch expiration or renewal buffer');
  }
  return Date.now() >= expiresAt - bufferMs;
}

/**
 * History-based polling for when Pub/Sub is not configured.
 */
export interface HistoryPage {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
  historyId: string;
  nextPageToken?: string;
}

export async function pollHistory(
  client: { listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage> },
  startHistoryId: string,
): Promise<{ newMessageIds: string[]; nextHistoryId: string }> {
  const newMessageIds: string[] = [];
  const visited = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await client.listHistory(startHistoryId, pageToken);
    for (const entry of response.history ?? []) {
      if (entry.messagesAdded) {
        for (const added of entry.messagesAdded) {
          newMessageIds.push(added.message.id);
        }
      }
    }
    const next = response.nextPageToken;
    if (next === undefined) {
      if (typeof response.historyId !== 'string' || !response.historyId) throw new Error('Missing history cursor');
      return { newMessageIds, nextHistoryId: response.historyId };
    }
    if (typeof next !== 'string' || !next || visited.has(next)) throw new Error('Invalid or repeated history page token');
    visited.add(next);
    pageToken = next;
  }
  throw new Error('History pagination exceeded its safety limit');
}
