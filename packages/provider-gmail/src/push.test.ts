import { describe, it, expect, vi } from 'vitest';
import { registerWatch, needsRenewal, pollHistory } from './push.js';

describe('provider-gmail/Dual Watch Mode', () => {
  it('Scenario: Pub/Sub auto-renewal', async () => {
    const mockClient = {
      watch: vi.fn().mockResolvedValue({
        historyId: '12345',
        expiration: new Date(Date.now() + 7 * 24 * 3600000).toISOString(),
      }),
    };

    // Register for Pub/Sub
    const registration = await registerWatch(mockClient, {
      topicName: 'projects/test/topics/gmail-push',
      labelIds: ['INBOX'],
    });

    expect(registration.historyId).toBe('12345');
    expect(registration.expiration).toBeDefined();

    // Check if renewal is needed — fresh registration should not need it
    expect(needsRenewal(registration.expiration)).toBe(false);

    // An expired registration should need renewal
    const expiredDate = new Date(Date.now() - 1000).toISOString();
    expect(needsRenewal(expiredDate)).toBe(true);

    // Within buffer (1 hour by default) should need renewal
    const nearExpiry = new Date(Date.now() + 1800000).toISOString(); // 30 min from now
    expect(needsRenewal(nearExpiry)).toBe(true);
  });

  it('Scenario: history.list fallback', async () => {
    const mockClient = {
      listHistory: vi.fn().mockResolvedValue({
        history: [
          {
            messagesAdded: [
              { message: { id: 'new-msg-1' } },
              { message: { id: 'new-msg-2' } },
            ],
          },
        ],
        historyId: '12346',
      }),
    };

    // Poll for new messages
    const result = await pollHistory(mockClient, '12345');

    expect(result.newMessageIds).toHaveLength(2);
    expect(result.newMessageIds).toContain('new-msg-1');
    expect(result.newMessageIds).toContain('new-msg-2');
    expect(result.nextHistoryId).toBe('12346');
  });
});
