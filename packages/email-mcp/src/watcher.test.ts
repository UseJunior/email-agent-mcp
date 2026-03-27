import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWatchMode,
  buildWakePayload,
  sendWake,
  getWakeToken,
  isProcessed,
  markProcessed,
  resetProcessed,
  needsSubscriptionRenewal,
} from './watcher.js';

beforeEach(() => {
  resetProcessed();
});

describe('email-watcher/Dual Mode Per Provider', () => {
  it('Scenario: Graph Delta Query (default for local)', () => {
    // WHEN Graph provider without public webhook URL
    const mode = getWatchMode('microsoft', false, false);
    expect(mode).toBe('polling');
  });

  it('Scenario: Graph Webhook (production)', () => {
    // WHEN Graph provider with public HTTPS webhook URL
    const mode = getWatchMode('microsoft', true, false);
    expect(mode).toBe('webhook');
  });

  it('Scenario: Gmail history.list (default for local)', () => {
    // WHEN Gmail provider without Pub/Sub
    const mode = getWatchMode('gmail', false, false);
    expect(mode).toBe('polling');
  });

  it('Scenario: Gmail Pub/Sub (production)', () => {
    // WHEN Gmail Pub/Sub is configured
    const mode = getWatchMode('gmail', false, true);
    expect(mode).toBe('pubsub');
  });
});

describe('email-watcher/Authenticated Wake POST', () => {
  it('Scenario: Wake with token', async () => {
    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    try {
      const payload = buildWakePayload('work', 'alice@corp.com', 'Contract Review');
      const result = await sendWake('http://localhost:18789/hooks/wake', payload, 'test-token');

      expect(result.success).toBe(true);

      // Verify Authorization header was sent
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:18789/hooks/wake',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('email-watcher/Wake Payload', () => {
  it('Scenario: Multi-mailbox wake', () => {
    const payload = buildWakePayload('work', 'alice@corp.com', 'Contract Review');

    expect(payload.text).toBe('[work] New email from alice@corp.com: Contract Review');
    expect(payload.mode).toBe('now');
  });
});

describe('email-watcher/Deduplication', () => {
  it('Scenario: Duplicate suppression', () => {
    // First detection — process it
    expect(isProcessed('msg-abc')).toBe(false);
    markProcessed('msg-abc');

    // Second detection — skip it
    expect(isProcessed('msg-abc')).toBe(true);

    // Different message — process it
    expect(isProcessed('msg-xyz')).toBe(false);
  });
});

describe('email-watcher/Subscription Lifecycle', () => {
  it('Scenario: Graph subscription renewal', () => {
    // Subscription approaching expiry (less than 1 hour)
    const soonExpiry = new Date(Date.now() + 30 * 60000).toISOString(); // 30 min
    expect(needsSubscriptionRenewal(soonExpiry)).toBe(true);

    // Subscription with plenty of time
    const farExpiry = new Date(Date.now() + 48 * 3600000).toISOString(); // 2 days
    expect(needsSubscriptionRenewal(farExpiry)).toBe(false);
  });

  it('Scenario: Gmail watch renewal', () => {
    // Gmail Pub/Sub approaching 7-day expiry
    const nearExpiry = new Date(Date.now() + 1800000).toISOString(); // 30 min
    expect(needsSubscriptionRenewal(nearExpiry)).toBe(true);

    // Fresh registration
    const freshExpiry = new Date(Date.now() + 7 * 24 * 3600000).toISOString(); // 7 days
    expect(needsSubscriptionRenewal(freshExpiry)).toBe(false);
  });
});

describe('email-watcher/Multi-Mailbox Monitoring', () => {
  it('Scenario: Two mailboxes', () => {
    // Verify wake payloads include the correct mailbox name
    const workPayload = buildWakePayload('work', 'alice@corp.com', 'Meeting Notes');
    expect(workPayload.text).toContain('[work]');

    const personalPayload = buildWakePayload('personal', 'friend@gmail.com', 'Weekend Plans');
    expect(personalPayload.text).toContain('[personal]');

    // Both should have different content
    expect(workPayload.text).not.toBe(personalPayload.text);
  });
});
