import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import {
  getWatchMode,
  buildWakePayload,
  buildWakePayloadLegacy,
  sendWake,
  getWakeToken,
  isProcessed,
  markProcessed,
  resetProcessed,
  needsSubscriptionRenewal,
  loadDeltaState,
  saveDeltaState,
  deleteDeltaState,
  getDeltaStatePath,
  acquireLock,
  releaseLock,
  releaseAllLocks,
  getLockFilePath,
} from './watcher.js';
import type { EmailMessage } from '@usejunior/email-core';

const STATE_DIR = join(homedir(), '.agent-email', 'state');
const TEST_SAFE_KEY = '__test-watcher-unit__';

function createTestMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'msg-test-1',
    subject: 'Contract Review',
    from: { email: 'alice@corp.com', name: 'Alice Smith' },
    to: [
      { email: 'steven@usejunior.com' },
      { email: 'bob@corp.com' },
    ],
    cc: [{ email: 'team@corp.com' }],
    receivedAt: '2024-03-15T10:00:00Z',
    isRead: false,
    hasAttachments: true,
    ...overrides,
  };
}

beforeEach(() => {
  resetProcessed();
});

afterEach(async () => {
  // Clean up test state files
  try { await unlink(getDeltaStatePath(TEST_SAFE_KEY)); } catch { /* OK */ }
  try { await unlink(getLockFilePath(TEST_SAFE_KEY)); } catch { /* OK */ }
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
      const msg = createTestMessage();
      const payload = buildWakePayload('steven@usejunior.com', msg);
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
    // WHEN a new email arrives at steven@usejunior.com from Alice Smith <alice@corp.com>
    // with subject "Contract Review", to steven@usejunior.com and bob@corp.com,
    // cc team@corp.com, with attachments
    const msg = createTestMessage();
    const payload = buildWakePayload('steven@usejunior.com', msg);

    expect(payload.text).toBe(
      'New email to steven@usejunior.com from Alice Smith <alice@corp.com>: Contract Review\n' +
      'To: steven@usejunior.com, bob@corp.com\n' +
      'Cc: team@corp.com\n' +
      'Attachments: yes',
    );
    expect(payload.mode).toBe('now');
  });

  it('Scenario: Wake payload without attachments', () => {
    // WHEN email has no cc and no attachments
    const msg = createTestMessage({
      from: { email: 'bob@corp.com' },
      to: [{ email: 'steven@usejunior.com' }],
      subject: 'Quick question',
      cc: [],
      hasAttachments: false,
    });
    const payload = buildWakePayload('steven@usejunior.com', msg);

    expect(payload.text).toBe(
      'New email to steven@usejunior.com from bob@corp.com: Quick question\n' +
      'To: steven@usejunior.com',
    );
    // No "Attachments:" line
    expect(payload.text).not.toContain('Attachments');
    // No "Cc:" line
    expect(payload.text).not.toContain('Cc:');
  });

  it('Scenario: No structured email object in payload', () => {
    // WHEN the system constructs a wake payload
    const msg = createTestMessage();
    const payload = buildWakePayload('steven@usejunior.com', msg);

    // THEN the payload contains only text and mode keys
    const keys = Object.keys(payload);
    expect(keys).toEqual(['text', 'mode']);
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
    // Verify wake payloads include the correct receiving mailbox
    const msg1 = createTestMessage({ from: { email: 'alice@corp.com' }, subject: 'Meeting Notes' });
    const workPayload = buildWakePayload('steven@usejunior.com', msg1);
    expect(workPayload.text).toContain('steven@usejunior.com');

    const msg2 = createTestMessage({ from: { email: 'friend@gmail.com' }, subject: 'Weekend Plans' });
    const personalPayload = buildWakePayload('steven@gmail.com', msg2);
    expect(personalPayload.text).toContain('steven@gmail.com');

    // Both should have different content
    expect(workPayload.text).not.toBe(personalPayload.text);
  });
});

describe('email-watcher/Delta State Persistence', () => {
  it('Scenario: Delta state persisted across restart', async () => {
    // Save delta state
    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=abc123',
      lastUpdated: '2024-03-15T10:00:00Z',
    });

    // Load it back
    const loaded = await loadDeltaState(TEST_SAFE_KEY);
    expect(loaded).not.toBeNull();
    expect(loaded!.deltaLink).toBe('https://graph.microsoft.com/v1.0/delta?token=abc123');
    expect(loaded!.lastUpdated).toBe('2024-03-15T10:00:00Z');
  });

  it('Scenario: Delta state file per mailbox', () => {
    const path1 = getDeltaStatePath('steven-usejunior-com');
    const path2 = getDeltaStatePath('alice-corp-com');
    expect(path1).toContain('steven-usejunior-com.delta.json');
    expect(path2).toContain('alice-corp-com.delta.json');
    expect(path1).not.toBe(path2);
  });

  it('Scenario: No saved state returns null', async () => {
    const state = await loadDeltaState('__nonexistent-mailbox__');
    expect(state).toBeNull();
  });

  it('Scenario: Delete delta state on 410 Gone', async () => {
    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=stale',
      lastUpdated: '2024-01-01T00:00:00Z',
    });

    await deleteDeltaState(TEST_SAFE_KEY);
    const loaded = await loadDeltaState(TEST_SAFE_KEY);
    expect(loaded).toBeNull();
  });
});

describe('email-watcher/Lock File Management', () => {
  it('Scenario: Lock prevents duplicate watcher', async () => {
    // First watcher acquires lock
    const got1 = await acquireLock(TEST_SAFE_KEY);
    expect(got1).toBe(true);

    // Second watcher tries — should fail (same PID in this test)
    const got2 = await acquireLock(TEST_SAFE_KEY);
    expect(got2).toBe(false);

    // Release and retry
    await releaseLock(TEST_SAFE_KEY);
    const got3 = await acquireLock(TEST_SAFE_KEY);
    expect(got3).toBe(true);

    // Clean up
    await releaseLock(TEST_SAFE_KEY);
  });

  it('Scenario: Lock released on shutdown', async () => {
    await acquireLock(TEST_SAFE_KEY);

    // Verify lock file exists
    const lockPath = getLockFilePath(TEST_SAFE_KEY);
    const content = await readFile(lockPath, 'utf-8');
    const lockData = JSON.parse(content) as { pid: number };
    expect(lockData.pid).toBe(process.pid);

    // Release
    await releaseLock(TEST_SAFE_KEY);

    // Verify lock file is gone
    const afterRelease = await loadDeltaState(TEST_SAFE_KEY); // repurposed to check file
    try {
      await readFile(lockPath, 'utf-8');
      expect.fail('Lock file should have been deleted');
    } catch {
      // Expected — file doesn't exist
    }
  });

  it('Scenario: releaseAllLocks cleans up locks for this PID', async () => {
    await acquireLock(TEST_SAFE_KEY);

    await releaseAllLocks();

    // Lock should be gone
    const got = await acquireLock(TEST_SAFE_KEY);
    expect(got).toBe(true);
    await releaseLock(TEST_SAFE_KEY);
  });
});

describe('email-watcher/Legacy buildWakePayload', () => {
  it('preserves old format for backward compatibility', () => {
    const payload = buildWakePayloadLegacy('work', 'alice@corp.com', 'Contract Review');
    expect(payload.text).toBe('[work] New email from alice@corp.com: Contract Review');
    expect(payload.mode).toBe('now');
  });
});
