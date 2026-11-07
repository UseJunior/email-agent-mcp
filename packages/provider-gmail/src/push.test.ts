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

describe('provider-gmail/Bounded history lifecycle', () => {
  it('retrieves every page before publishing the final cursor', async () => {
    const listHistory = vi.fn()
      .mockResolvedValueOnce({ history: [{ messagesAdded: [{ message: { id: 'first' } }] }], historyId: 'intermediate', nextPageToken: 'page2' })
      .mockResolvedValueOnce({ history: [{ messagesAdded: [{ message: { id: 'second' } }] }], historyId: 'final' });
    await expect(pollHistory({ listHistory }, 'start')).resolves.toEqual({ newMessageIds: ['first', 'second'], nextHistoryId: 'final' });
    expect(listHistory.mock.calls).toEqual([['start', undefined], ['start', 'page2']]);
  });
  it('does not return partial progress after a page error or repeated token', async () => {
    const listHistory = vi.fn().mockResolvedValueOnce({ historyId: 'partial', nextPageToken: 'again' }).mockRejectedValueOnce(new Error('page failed'));
    await expect(pollHistory({ listHistory }, 'start')).rejects.toThrow('page failed');
    listHistory.mockReset().mockResolvedValue({ historyId: 'partial', nextPageToken: 'again' });
    await expect(pollHistory({ listHistory }, 'start')).rejects.toThrow('repeated');
    expect(listHistory).toHaveBeenCalledTimes(2);
  });
  it('bounds unique pages and rejects a missing final cursor', async () => {
    let count = 0;
    const listHistory = vi.fn(async () => ({ historyId: 'partial', nextPageToken: String(++count) }));
    await expect(pollHistory({ listHistory }, 'start')).rejects.toThrow('safety limit');
    expect(count).toBe(100);
    await expect(pollHistory({ listHistory: vi.fn().mockResolvedValue({}) }, 'start')).rejects.toThrow('Missing history cursor');
  });
  it('validates expiry and supports Gmail epoch milliseconds', () => {
    expect(needsRenewal(String(Date.now() + 7_200_000))).toBe(false);
    expect(() => needsRenewal('invalid')).toThrow('Invalid');
    expect(() => needsRenewal(new Date().toISOString(), -1)).toThrow('Invalid');
  });
});
