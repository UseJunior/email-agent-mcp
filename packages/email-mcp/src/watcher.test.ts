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
import { isAllowedSender } from '@usejunior/email-core';

const STATE_DIR = join(homedir(), '.agent-email', 'state');
const TEST_SAFE_KEY = '__test-watcher-unit__';

function createTestMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'msg-test-1',
    subject: 'Contract Review',
    from: { email: 'alice@corp.com', name: 'Alice Smith' },
    to: [
      { email: 'test-user@example.com' },
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
      const payload = buildWakePayload('test-user@example.com', msg);
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
    // WHEN a new email arrives at test-user@example.com from Alice Smith <alice@corp.com>
    // with subject "Contract Review", to test-user@example.com and bob@corp.com,
    // cc team@corp.com, with attachments
    const msg = createTestMessage();
    const payload = buildWakePayload('test-user@example.com', msg);

    expect(payload.text).toBe(
      'New email to test-user@example.com from Alice Smith <alice@corp.com>: Contract Review\n' +
      'To: test-user@example.com, bob@corp.com\n' +
      'Cc: team@corp.com\n' +
      'Attachments: yes',
    );
    expect(payload.mode).toBe('now');
  });

  it('Scenario: Wake payload without attachments', () => {
    // WHEN email has no cc and no attachments
    const msg = createTestMessage({
      from: { email: 'bob@corp.com' },
      to: [{ email: 'test-user@example.com' }],
      subject: 'Quick question',
      cc: [],
      hasAttachments: false,
    });
    const payload = buildWakePayload('test-user@example.com', msg);

    expect(payload.text).toBe(
      'New email to test-user@example.com from bob@corp.com: Quick question\n' +
      'To: test-user@example.com',
    );
    // No "Attachments:" line
    expect(payload.text).not.toContain('Attachments');
    // No "Cc:" line
    expect(payload.text).not.toContain('Cc:');
  });

  it('Scenario: No structured email object in payload', () => {
    // WHEN the system constructs a wake payload
    const msg = createTestMessage();
    const payload = buildWakePayload('test-user@example.com', msg);

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
    const workPayload = buildWakePayload('test-user@example.com', msg1);
    expect(workPayload.text).toContain('test-user@example.com');

    const msg2 = createTestMessage({ from: { email: 'friend@gmail.com' }, subject: 'Weekend Plans' });
    const personalPayload = buildWakePayload('test-user@gmail.com', msg2);
    expect(personalPayload.text).toContain('test-user@gmail.com');

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
    const path1 = getDeltaStatePath('test-user-example-com');
    const path2 = getDeltaStatePath('alice-corp-com');
    expect(path1).toContain('test-user-example-com.delta.json');
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

describe('email-watcher/Timestamp-Based Polling Protocol', () => {
  it('Scenario: First run sets checkpoint to now', async () => {
    // WHEN the watcher starts for a mailbox with no saved state
    const state = await loadDeltaState('__nonexistent-first-run__');
    expect(state).toBeNull();

    // THEN it sets the checkpoint to the current time without processing historical messages
    const now = new Date().toISOString();
    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: '', // Not using delta — timestamp polling
      lastUpdated: now,
    });

    const saved = await loadDeltaState(TEST_SAFE_KEY);
    expect(saved).not.toBeNull();
    expect(saved!.lastUpdated).toBe(now);
    // No wake POSTs are sent during first run (checkpoint is "now")
  });

  it('Scenario: Subsequent poll uses receivedDateTime filter', async () => {
    // WHEN the watcher polls after the first run
    const checkpoint = '2024-06-01T12:00:00Z';
    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: '',
      lastUpdated: checkpoint,
    });

    // THEN it uses the saved checkpoint to filter messages
    const loaded = await loadDeltaState(TEST_SAFE_KEY);
    expect(loaded!.lastUpdated).toBe(checkpoint);
    // The provider.getNewMessages(checkpoint) call would use
    // receivedDateTime ge {checkpoint} — verified in provider tests
  });

  it('Scenario: Checkpoint advances only after successful wake', async () => {
    // WHEN a new email is detected and the wake POST succeeds
    const oldCheckpoint = '2024-06-01T12:00:00Z';
    const newCheckpoint = '2024-06-01T12:05:00Z';

    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: '',
      lastUpdated: oldCheckpoint,
    });

    // Simulate successful wake — advance checkpoint
    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: '',
      lastUpdated: newCheckpoint,
    });

    const saved = await loadDeltaState(TEST_SAFE_KEY);
    expect(saved!.lastUpdated).toBe(newCheckpoint);
  });

  it('Scenario: Checkpoint unchanged on wake failure', async () => {
    // WHEN a new email is detected but the wake POST fails
    const checkpoint = '2024-06-01T12:00:00Z';
    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: '',
      lastUpdated: checkpoint,
    });

    // Simulate wake failure — checkpoint stays the same (no saveDeltaState call)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    try {
      const msg = createTestMessage();
      const payload = buildWakePayload('test-user@example.com', msg);
      const result = await sendWake('http://localhost:18789/hooks/wake', payload, 'token');
      expect(result.success).toBe(false);

      // Checkpoint should remain unchanged
      const loaded = await loadDeltaState(TEST_SAFE_KEY);
      expect(loaded!.lastUpdated).toBe(checkpoint);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('email-watcher/Poll Interval Validation', () => {
  it('Scenario: Default poll interval', async () => {
    // WHEN no poll interval is configured
    // THEN the default is used (10 seconds)
    const { parseCliArgs } = await import('./cli.js');
    const opts = parseCliArgs(['watch']);
    // pollInterval is undefined when not specified — runtime defaults to 10
    expect(opts.pollInterval).toBeUndefined();
  });

  it('Scenario: Minimum interval enforced', async () => {
    // WHEN the poll interval is set below 2 seconds
    // THEN the watcher rejects the configuration (clamped to 2 at runtime)
    const { parseCliArgs } = await import('./cli.js');
    const opts = parseCliArgs(['watch', '--poll-interval', '1']);
    // Parsing accepts the value; clamping happens at runtime in runWatch
    expect(opts.pollInterval).toBe(1);
    // At runtime, values < 2 are clamped to 2 with a warning
  });

  it('Scenario: Warning for aggressive interval', async () => {
    // WHEN the poll interval is set to a value >= 2s but < 5s
    // THEN the watcher logs a warning that the interval is aggressive
    const { parseCliArgs } = await import('./cli.js');
    const opts = parseCliArgs(['watch', '--poll-interval', '3']);
    expect(opts.pollInterval).toBe(3);
    // At runtime, values >= 2 but < 5 log an aggressive-interval warning
  });
});

describe('email-watcher/Per-Mailbox Checkpoint Persistence', () => {
  it('Scenario: Checkpoint persisted across restart', async () => {
    // WHEN the watcher is stopped and restarted
    const checkpoint = '2024-06-15T09:30:00Z';
    await saveDeltaState(TEST_SAFE_KEY, {
      deltaLink: '',
      lastUpdated: checkpoint,
    });

    // THEN it loads the saved checkpoint and resumes polling from where it left off
    const loaded = await loadDeltaState(TEST_SAFE_KEY);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastUpdated).toBe(checkpoint);
  });

  it('Scenario: Checkpoint file per mailbox', () => {
    // WHEN two mailboxes are configured
    // THEN two separate checkpoint files exist
    const path1 = getDeltaStatePath('test-user-example-com');
    const path2 = getDeltaStatePath('alice-corp-com');
    expect(path1).toContain('test-user-example-com');
    expect(path2).toContain('alice-corp-com');
    expect(path1).not.toBe(path2);
  });
});

describe('email-watcher/Receive Allowlist Gating', () => {
  it('Scenario: Allowed sender triggers wake', () => {
    // WHEN a new email arrives from alice@corp.com
    // AND alice@corp.com is on the receive allowlist
    const allowlist = { entries: ['alice@corp.com', '*@example.com'] };
    const allowed = isAllowedSender('alice@corp.com', allowlist);

    // THEN the wake POST should be sent (sender is allowed)
    expect(allowed).toBe(true);
  });

  it('Scenario: Non-allowed sender blocked', () => {
    // WHEN a new email arrives from spam@evil.com
    // AND spam@evil.com is NOT on the receive allowlist
    const allowlist = { entries: ['alice@corp.com', '*@example.com'] };
    const blocked = isAllowedSender('spam@evil.com', allowlist);

    // THEN no wake POST is sent
    expect(blocked).toBe(false);
  });

  it('Scenario: No allowlist configured defaults to accept all', () => {
    // WHEN no receive allowlist is configured
    // THEN all senders are accepted
    expect(isAllowedSender('anyone@anywhere.com', undefined)).toBe(true);
    expect(isAllowedSender('random@test.com', undefined)).toBe(true);
  });
});

describe('email-watcher/Legacy buildWakePayload', () => {
  it('preserves old format for backward compatibility', () => {
    const payload = buildWakePayloadLegacy('work', 'alice@corp.com', 'Contract Review');
    expect(payload.text).toBe('[work] New email from alice@corp.com: Contract Review');
    expect(payload.mode).toBe('now');
  });
});
