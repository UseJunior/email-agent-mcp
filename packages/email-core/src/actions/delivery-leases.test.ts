import { describe, expect, it, vi } from 'vitest';
import { SendLedger, type SendClaim } from '../security/send-ledger.js';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { ProviderError } from '../providers/provider.js';
import type { ActionContext } from './registry.js';
import { sendEmailAction } from './send.js';
import { replyToEmailAction } from './reply.js';
import { sendDraftAction } from './draft.js';
import { SendRateLimiter } from '../security/send-allowlist.js';

function barrier() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

class ObservedLedger extends SendLedger {
  readonly leases: SendClaim[] = [];
  override claim(...args: Parameters<SendLedger['claim']>) {
    const result = super.claim(...args);
    if (result.ok) this.leases.push(result);
    return result;
  }
}

const paths = ['send', 'schedule-send', 'reply', 'draft', 'schedule-draft'] as const;

describe.each(paths)('email-security/Rate Limiting action integration (%s)', path => {
  it('Scenario: Capacity barrier prevents concurrent provider dispatch', async () => {
    const f = await fixture(path);
    let now = 0;
    const limiter = new SendRateLimiter(1, 100, () => now);
    f.ctx.rateLimiter = limiter;
    const entered = barrier(), finish = barrier();
    f.dispatch.mockImplementation(async () => {
      entered.open();
      await finish.promise;
      return { success: true, messageId: 'accepted' };
    });
    const first = f.run();
    await entered.promise;
    now = 1000; // live capacity cannot expire during a slow dispatch
    const contenders = await Promise.all(Array.from({ length: 8 }, () => f.run(true)));
    expect(contenders.every(result => result.error?.code === 'RATE_LIMITED' && result.error.retryAfter === 1)).toBe(true);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    finish.open();
    expect((await first).success).toBe(true);
    expect((await f.run(true)).error?.code).toBe('RATE_LIMITED');
    now += 100;
    expect((await f.run(true)).success).toBe(true);
  });

  it.each(['accepted', 'unknown', 'throw', 'rejected', 'throw-rejected', 'unclassified-result'] as const)(
    'Scenario: Dispatch %s has conservative terminal rate accounting', async outcome => {
      const f = await fixture(path);
      const limiter = new SendRateLimiter(1, 60_000);
      f.ctx.rateLimiter = limiter;
      f.dispatch.mockImplementation(async () => {
        if (outcome === 'throw') throw new Error('synthetic lost response');
        if (outcome === 'throw-rejected') throw new ProviderError('INVALID_REQUEST', 'synthetic rejection', 'mock', false);
        if (outcome === 'accepted') return { success: true, messageId: 'accepted' };
        if (outcome === 'unclassified-result') return { success: false };
        return { success: false, error: new ProviderError(outcome === 'rejected' ? 'INVALID_REQUEST' : 'SEND_STATUS_UNKNOWN', 'synthetic outcome', 'mock', false) };
      });
      await f.run();
      const released = outcome === 'rejected' || outcome === 'throw-rejected';
      expect(limiter.checkLimit('other_action').allowed).toBe(released);
      await f.run(true);
      expect(f.dispatch).toHaveBeenCalledTimes(released ? 2 : 1);
    },
  );

  it('Scenario: Reservation API is preferred over legacy check and record', async () => {
    const f = await fixture(path);
    const consume = vi.fn();
    const checkLimit = vi.fn(() => ({ allowed: false }));
    const recordUsage = vi.fn();
    f.ctx.rateLimiter = { tryReserve: () => ({ allowed: true, lease: { consume, release: vi.fn() } }), checkLimit, recordUsage };
    f.dispatch.mockResolvedValue({ success: true });
    await f.run();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(checkLimit).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('email-security/Rate Limiting preflight', () => {
  describe.each(['lookup', 'empty', 'allowlist', 'deferred', 'canonical-duplicate'] as const)('%s', failure => {
    it('Scenario: Draft preflight failure releases capacity', async () => {
      const f = await fixture('draft', 32);
      const limiter = new SendRateLimiter(1, 1000);
      f.ctx.rateLimiter = limiter;
      const snapshot = await f.provider.getDraftSnapshot('draft-1');
      const read = vi.spyOn(f.provider, 'getDraftSnapshot').mockResolvedValue({
        ...snapshot, draftId: 'canonical-draft',
        ...(failure === 'deferred' ? { lifecycle: 'deferred' as const } : {}),
        message: { ...snapshot.message, ...(failure === 'empty' ? { to: [] } : {}) },
      });
      if (failure === 'lookup') read.mockRejectedValue(new ProviderError('NOT_FOUND', 'synthetic missing', 'mock', false));
      if (failure === 'allowlist') f.ctx.sendAllowlist = { entries: [] };
      if (failure === 'canonical-duplicate') {
        // Establish canonical evidence without charging the limiter.
        const prior = { ...f.ctx, rateLimiter: undefined };
        f.dispatch.mockResolvedValue({ success: true });
        await sendDraftAction.run(prior, { draft_id: 'canonical-draft' });
        f.dispatch.mockClear();
      }
      expect((await f.run()).success).toBe(false);
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(limiter.tryReserve('send_email').allowed).toBe(true);
    });
  });

  it('Scenario: Unsupported scheduling releases capacity', async () => {
    const f = await fixture('schedule-send');
    const limiter = new SendRateLimiter(1, 1000);
    f.ctx.rateLimiter = limiter;
    f.provider.scheduleMessage = undefined as never;
    expect((await f.run()).error?.code).toBe('NOT_SUPPORTED');
    expect(limiter.tryReserve('send_email').allowed).toBe(true);
  });
});

async function fixture(path: typeof paths[number], maxEntries = 1) {
  let now = 0;
  const ledger = new ObservedLedger({ windowMs: 100, maxEntries, now: () => now });
  const provider = new MockEmailProvider();
  const ctx: ActionContext = { provider, sendLedger: ledger, sendAllowlist: { entries: ['*@allowed.com'] } };
  const messageId = 'abc123def456ghi789jkl012';
  provider.addMessage({ id: messageId, from: { email: 'alice@allowed.com' } });
  const draft = await provider.createDraft({ to: [{ email: 'alice@allowed.com' }], subject: 'Lease test', body: 'Synthetic body' });
  const scheduled_send_at = new Date(Date.now() + 3_600_000).toISOString();
  const run = (allow_duplicate = false) => {
    switch (path) {
      case 'send':
      case 'schedule-send':
        return sendEmailAction.run(ctx, {
          to: 'alice@allowed.com', subject: 'Lease test', body: 'Synthetic body', allow_duplicate,
          ...(path === 'schedule-send' ? { scheduled_send_at } : {}),
        });
      case 'reply':
        return replyToEmailAction.run(ctx, { message_id: messageId, body: 'Synthetic reply', reply_all: false, allow_duplicate });
      case 'draft':
      case 'schedule-draft':
        return sendDraftAction.run(ctx, {
          draft_id: draft.draftId!, allow_duplicate,
          ...(path === 'schedule-draft' ? { scheduled_send_at } : {}),
        });
    }
  };
  const method = {
    send: 'sendMessage', 'schedule-send': 'scheduleMessage', reply: 'replyToMessage',
    draft: 'sendDraft', 'schedule-draft': 'scheduleDraft',
  }[path] as 'sendMessage' | 'scheduleMessage' | 'replyToMessage' | 'sendDraft' | 'scheduleDraft';
  const dispatch = vi.spyOn(provider, method);
  return { ctx, ledger, provider, run, dispatch, scheduled_send_at, advance: (ms: number) => { now += ms; } };
}

describe.each(paths)('email-write/Delivery lease integration (%s)', path => {
  it('marks dispatched before invocation and blocks long requests despite late release and sibling rejection', async () => {
    const f = await fixture(path);
    const entered = barrier(), finish = barrier();
    let calls = 0;
    f.dispatch.mockImplementation(async () => {
      expect(f.ledger.leases.every(lease => lease.leaseState === 'dispatched' || lease.leaseState === 'settled')).toBe(true);
      f.ledger.leases.forEach(lease => lease.release()); // cannot weaken dispatched/settled leases
      if (++calls === 1) {
        entered.open();
        await finish.promise;
        return { success: false, error: new ProviderError('INVALID_REQUEST', 'rejected', 'mock', false) };
      }
      return { success: true, messageId: 'accepted-sibling' };
    });
    const slow = f.run();
    await entered.promise;
    f.advance(1000);
    expect((await f.run()).error?.code).toBe('DUPLICATE_SEND_IN_FLIGHT');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect((await f.run(true)).success).toBe(true);
    expect((await f.run()).messageId).toBe('accepted-sibling');
    finish.open();
    await slow;
    const replay = await f.run();
    expect(replay.error?.code).toBe('DUPLICATE_SEND_BLOCKED');
    expect(replay.messageId).toBe('accepted-sibling');
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    f.advance(101);
    expect((await f.run()).success).toBe(true);
    expect(f.dispatch).toHaveBeenCalledTimes(3);
  });

  it.each(['throw', 'unknown', 'rejected', 'throw-rejected', 'accepted'] as const)(
    'settles %s exactly once and preserves replay behavior', async outcome => {
      const f = await fixture(path);
      f.dispatch.mockImplementation(async () => {
        if (outcome === 'throw') throw new Error('lost response');
        if (outcome === 'throw-rejected') throw new ProviderError('INVALID_REQUEST', 'rejected', 'mock', false);
        if (outcome === 'accepted') return { success: true, messageId: 'accepted' };
        return {
          success: false,
          error: new ProviderError(outcome === 'rejected' ? 'INVALID_REQUEST' : 'SEND_STATUS_UNKNOWN', 'synthetic failure', 'mock', false),
        };
      });
      await f.run();
      expect(f.ledger.leases.every(lease => lease.leaseState === 'settled')).toBe(true);
      const replay = await f.run();
      if (outcome === 'rejected' || outcome === 'throw-rejected') {
        expect(f.dispatch).toHaveBeenCalledTimes(2);
      } else {
        expect(replay.error?.code).toBe(outcome === 'accepted' ? 'DUPLICATE_SEND_BLOCKED' : 'DUPLICATE_SEND_UNRESOLVED');
        expect(f.dispatch).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('a post-settlement bookkeeping throw cannot downgrade accepted evidence', async () => {
    const f = await fixture(path);
    f.dispatch.mockResolvedValue({ success: true, messageId: 'accepted' });
    f.ctx.rateLimiter = {
      checkLimit: () => ({ allowed: true }),
      recordUsage: () => { throw new Error('bookkeeping failed'); },
    };
    expect((await f.run()).success).toBe(true);
    expect((await f.run()).messageId).toBe('accepted');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('email-write/Canonical draft leases', () => {
  it.each([
    { path: 'draft', a: 'message-alias', b: 'canonical-draft' },
    { path: 'draft', a: 'message-alias', b: 'second-message-alias' },
    { path: 'schedule-draft', a: 'message-alias', b: 'canonical-draft' },
    { path: 'schedule-draft', a: 'message-alias', b: 'second-message-alias' },
  ] as const)('Scenario: Concurrent draft aliases dispatch at most once ($path, $a, $b)', async ({ path, a, b }) => {
    const f = await fixture(path, 32);
    const run = (draft_id: string) => sendDraftAction.run(f.ctx, {
      draft_id, ...(path === 'schedule-draft' ? { scheduled_send_at: f.scheduled_send_at } : {}),
    });
    const snapshot = await f.provider.getDraftSnapshot('draft-1');
    const readBoth = barrier(), finishReads = barrier(), dispatched = barrier(), finishDispatch = barrier();
    let reads = 0;
    const lookup = vi.spyOn(f.provider, 'getDraftSnapshot').mockImplementation(async () => {
      if (++reads === 2) readBoth.open();
      await finishReads.promise;
      return { ...snapshot, draftId: 'canonical-draft' };
    });
    f.dispatch.mockImplementation(async () => {
      dispatched.open();
      await finishDispatch.promise;
      return { success: true, messageId: 'one-delivery' };
    });
    const first = run(a);
    const second = run(b);
    await readBoth.promise;
    f.advance(1000);
    expect((await run(a)).error?.code).toBe('DUPLICATE_SEND_IN_FLIGHT');
    expect(lookup).toHaveBeenCalledTimes(2); // active preflight is still reserved
    finishReads.open();
    await dispatched.promise;
    const loser = await Promise.race([first, second]);
    expect(loser.error?.code).toBe('DUPLICATE_SEND_IN_FLIGHT');
    f.advance(1000);
    expect((await run('canonical-draft')).error?.code).toBe('DUPLICATE_SEND_IN_FLIGHT');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    finishDispatch.open();
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.success)).toHaveLength(1);
    const winner = results[0]!.success ? a : b;
    lookup.mockRejectedValue(new Error('draft consumed'));
    const readCount = lookup.mock.calls.length;
    expect((await run(winner)).messageId).toBe('one-delivery');
    expect(lookup).toHaveBeenCalledTimes(readCount); // input guard still precedes lookup
    expect(f.ledger.leases.filter(lease => lease.leaseState === 'settled')).toHaveLength(winner === 'canonical-draft' ? 1 : 2);
  });

  it.each(['draft', 'schedule-draft'] as const)('late forced alias rejection cannot erase accepted siblings (%s)', async path => {
    const f = await fixture(path, 32);
    const snapshot = await f.provider.getDraftSnapshot('draft-1');
    vi.spyOn(f.provider, 'getDraftSnapshot').mockResolvedValue({ ...snapshot, draftId: 'canonical-draft' });
    const originalEntered = barrier(), originalFinish = barrier(), forcedEntered = barrier(), forcedFinish = barrier();
    let calls = 0;
    f.dispatch.mockImplementation(async () => {
      if (++calls === 1) {
        originalEntered.open();
        await originalFinish.promise;
        return { success: true, messageId: 'accepted-original' };
      }
      forcedEntered.open();
      await forcedFinish.promise;
      return { success: false, error: new ProviderError('INVALID_REQUEST', 'rejected override', 'mock', false) };
    });
    const original = f.run();
    await originalEntered.promise;
    const forced = sendDraftAction.run(f.ctx, {
      draft_id: 'different-alias', allow_duplicate: true,
      ...(path === 'schedule-draft' ? { scheduled_send_at: f.scheduled_send_at } : {}),
    });
    await forcedEntered.promise;
    originalFinish.open();
    await original;
    expect((await f.run()).messageId).toBe('accepted-original');
    forcedFinish.open();
    await forced;
    const canonical = f.ledger.leases[1]!;
    expect(f.ledger.peekAll(canonical.fingerprint)).toHaveLength(1);
    expect(f.ledger.peek(canonical.fingerprint)?.messageId).toBe('accepted-original');
    expect((await f.run()).messageId).toBe('accepted-original');
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(['draft', 'schedule-draft'] as const)('unknown throws settle both alias reservations (%s)', async path => {
    const f = await fixture(path, 32);
    const snapshot = await f.provider.getDraftSnapshot('draft-1');
    vi.spyOn(f.provider, 'getDraftSnapshot').mockResolvedValue({ ...snapshot, draftId: 'canonical-draft' });
    f.dispatch.mockRejectedValue(new Error('lost acknowledgement'));
    await f.run();
    expect(f.ledger.leases).toHaveLength(2);
    for (const lease of f.ledger.leases) {
      expect(lease.leaseState).toBe('settled');
      expect(f.ledger.peek(lease.fingerprint)?.state).toBe('unresolved');
    }
    expect((await f.run()).error?.code).toBe('DUPLICATE_SEND_UNRESOLVED');
    expect((await sendDraftAction.run(f.ctx, {
      draft_id: 'canonical-draft',
      ...(path === 'schedule-draft' ? { scheduled_send_at: f.scheduled_send_at } : {}),
    })).error?.code).toBe('DUPLICATE_SEND_UNRESOLVED');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['draft', 'schedule-draft'] as const)('forced aliases retain sibling evidence and release both claims on rejection (%s)', async path => {
    const f = await fixture(path, 32);
    const snapshot = await f.provider.getDraftSnapshot('draft-1');
    vi.spyOn(f.provider, 'getDraftSnapshot').mockResolvedValue({ ...snapshot, draftId: 'canonical-draft' });
    f.dispatch.mockResolvedValueOnce({ success: true, messageId: 'original' })
      .mockResolvedValueOnce({ success: false, error: new ProviderError('INVALID_REQUEST', 'rejected', 'mock', false) });
    // fixture uses an input alias, so every dispatch owns two independent claims.
    expect((await f.run()).success).toBe(true);
    expect((await f.run(true)).success).toBe(false);
    expect((await f.run()).messageId).toBe('original');
    expect((await sendDraftAction.run(f.ctx, {
      draft_id: 'canonical-draft',
      ...(path === 'schedule-draft' ? { scheduled_send_at: f.scheduled_send_at } : {}),
    })).messageId).toBe('original');
    // Check the retained canonical sibling using the exact schedule fingerprint.
    const canonicalLease = f.ledger.leases[1]!;
    expect(f.ledger.peekAll(canonicalLease.fingerprint)).toHaveLength(1);
    expect(f.ledger.peek(canonicalLease.fingerprint)?.messageId).toBe('original');
    expect(f.ledger.leases).toHaveLength(4);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(['lookup', 'allowlist', 'empty', 'rate-limit'] as const)('preflight %s failure releases every reserved identity', async failure => {
    const f = await fixture('draft');
    const snapshot = await f.provider.getDraftSnapshot('draft-1');
    const read = vi.spyOn(f.provider, 'getDraftSnapshot').mockResolvedValue({
      ...snapshot, draftId: 'canonical-draft',
      message: { ...snapshot.message, ...(failure === 'empty' ? { to: [] } : {}) },
    });
    if (failure === 'lookup') read.mockRejectedValue(new ProviderError('NOT_FOUND', 'missing', 'mock', false));
    if (failure === 'allowlist') f.ctx.sendAllowlist = { entries: ['nobody@example.com'] };
    if (failure === 'rate-limit') f.ctx.rateLimiter = { checkLimit: () => ({ allowed: false }), recordUsage: () => {} };
    const first = await f.run();
    const second = await f.run();
    expect(first.success).toBe(false);
    expect(second.error?.code).toBe(first.error?.code);
    expect(f.ledger.leases.every(lease => lease.leaseState === 'released')).toBe(true);
    expect(f.ledger.size()).toBe(0);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
