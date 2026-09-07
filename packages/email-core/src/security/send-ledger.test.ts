import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SendLedger,
  computeSendFingerprint,
  duplicateSendError,
  getDefaultSendLedger,
  resetDefaultSendLedger,
  resolveDuplicateSendWindowMs,
  isDeliveryProvenUnsent,
  DEFAULT_DUPLICATE_SEND_WINDOW_MS,
  DUPLICATE_SEND_IN_FLIGHT,
  DUPLICATE_SEND_BLOCKED,
  DUPLICATE_SEND_UNRESOLVED,
} from './send-ledger.js';

const BASE = {
  action: 'send_email',
  mailbox: 'me@company.com',
  to: [{ email: 'alice@allowed.com' }],
  subject: 'Quarterly update',
  body: 'Numbers attached.',
} as const;

describe('email-write/Send Fingerprint', () => {
  it('is stable across calls with identical input', () => {
    expect(computeSendFingerprint(BASE)).toBe(computeSendFingerprint(BASE));
  });

  it('ignores recipient display name and ordering', () => {
    const a = computeSendFingerprint({
      ...BASE,
      to: [{ email: 'alice@allowed.com', name: 'Alice' }, { email: 'bob@allowed.com' }],
    });
    const b = computeSendFingerprint({
      ...BASE,
      to: [{ email: 'BOB@allowed.com' }, { email: 'alice@allowed.com' }],
    });
    // Same mailboxes reached — a display name is not part of what is delivered.
    expect(a).toBe(b);
  });

  it('separates a reply from a fresh send with the same content', () => {
    expect(computeSendFingerprint({ ...BASE, action: 'reply_to_email' }))
      .not.toBe(computeSendFingerprint(BASE));
  });

  it('separates sends that differ in any delivered field', () => {
    const base = computeSendFingerprint(BASE);
    expect(computeSendFingerprint({ ...BASE, subject: 'Quarterly update ' })).not.toBe(base);
    expect(computeSendFingerprint({ ...BASE, body: 'Numbers attached!' })).not.toBe(base);
    expect(computeSendFingerprint({ ...BASE, mailbox: 'other@company.com' })).not.toBe(base);
    expect(computeSendFingerprint({ ...BASE, cc: [{ email: 'carol@allowed.com' }] })).not.toBe(base);
    expect(computeSendFingerprint({ ...BASE, bodyHtml: '<p>x</p>' })).not.toBe(base);
    expect(computeSendFingerprint({ ...BASE, scheduledSendAt: '2026-09-08T09:00:00Z' })).not.toBe(base);
  });

  it('distinguishes attachments by content, not just filename', () => {
    const withA = computeSendFingerprint({
      ...BASE,
      attachments: [{ filename: 'q3.pdf', mimeType: 'application/pdf', content: Buffer.from('AAA') }],
    });
    const withB = computeSendFingerprint({
      ...BASE,
      attachments: [{ filename: 'q3.pdf', mimeType: 'application/pdf', content: Buffer.from('BBB') }],
    });
    expect(withA).not.toBe(withB);
    expect(withA).not.toBe(computeSendFingerprint(BASE));
  });
});

describe('email-write/Send Ledger', () => {
  let ledger: SendLedger;
  const FP = 'fingerprint-1';

  beforeEach(() => {
    ledger = new SendLedger({ windowMs: 60_000 });
  });

  it('admits a first claim', () => {
    const claim = ledger.claim(FP);
    expect(claim.ok).toBe(true);
    expect(ledger.peek(FP)).toMatchObject({ state: 'in-flight' });
  });

  it('refuses a second claim while the first is in flight', () => {
    ledger.claim(FP);
    const second = ledger.claim(FP);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.prior.state).toBe('in-flight');
  });

  it('refuses a second claim after a delivered attempt, keeping the message id', () => {
    const claim = ledger.claim(FP);
    if (claim.ok) claim.settle({ success: true, messageId: 'AAMk-1' });

    const second = ledger.claim(FP);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.prior.state).toBe('delivered');
      expect(second.prior.messageId).toBe('AAMk-1');
    }
  });

  it('refuses a second claim after an ambiguous outcome', () => {
    const claim = ledger.claim(FP);
    if (claim.ok) claim.settle({ success: false, errorCode: 'SEND_STATUS_UNKNOWN' });

    const second = ledger.claim(FP);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.prior.state).toBe('unresolved');
  });

  it('releases the fingerprint after a failure that proves nothing was sent', () => {
    for (const code of ['INVALID_REQUEST', 'RATE_LIMITED', 'PROVIDER_UNREACHABLE', 'ALLOWLIST_BLOCKED']) {
      const claim = ledger.claim(code);
      if (claim.ok) claim.settle({ success: false, errorCode: code });
      expect(ledger.peek(code)).toBeUndefined();
      expect(ledger.claim(code).ok).toBe(true);
    }
  });

  it('holds an unrecognized failure code as unresolved rather than releasing it', () => {
    // Fail closed: a code this version has never seen could have been a
    // post-acceptance failure, and a wrong release costs a duplicate.
    const claim = ledger.claim(FP);
    if (claim.ok) claim.settle({ success: false, errorCode: 'SOME_FUTURE_PROVIDER_CODE' });
    const second = ledger.claim(FP);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.prior.state).toBe('unresolved');
  });

  it('holds an outcome with no code at all as unresolved', () => {
    const claim = ledger.claim(FP);
    if (claim.ok) claim.settle({ success: false });
    expect(ledger.peek(FP)).toMatchObject({ state: 'unresolved' });
  });

  it('forgets an attempt once the window passes', () => {
    let now = 1_000_000;
    const clocked = new SendLedger({ windowMs: 60_000, now: () => now });
    const claim = clocked.claim(FP);
    if (claim.ok) claim.settle({ success: true, messageId: 'm1' });

    now += 59_000;
    expect(clocked.claim(FP).ok).toBe(false);

    now += 2_000;
    expect(clocked.claim(FP).ok).toBe(true);
  });

  it('ages an abandoned in-flight claim from its start, so a throw cannot wedge it forever', () => {
    let now = 1_000_000;
    const clocked = new SendLedger({ windowMs: 60_000, now: () => now });
    clocked.claim(FP); // never settled — the action threw between claim and settle

    now += 30_000;
    expect(clocked.claim(FP).ok).toBe(false);

    now += 31_000;
    expect(clocked.claim(FP).ok).toBe(true);
  });

  it('force re-claims for a deliberate duplicate and re-arms against ITS replay', () => {
    const claim = ledger.claim(FP);
    if (claim.ok) claim.settle({ success: true, messageId: 'm1' });

    const forced = ledger.claim(FP, { force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) forced.settle({ success: true, messageId: 'm2' });

    // The deliberate duplicate is itself now protected.
    const third = ledger.claim(FP);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.prior.messageId).toBe('m2');
  });

  it('release drops an in-flight reservation so a pre-dispatch bail-out does not block', () => {
    const claim = ledger.claim(FP);
    if (claim.ok) claim.release();
    expect(ledger.peek(FP)).toBeUndefined();
    expect(ledger.claim(FP).ok).toBe(true);
  });

  it('release does not reopen an attempt that already settled', () => {
    // A settled attempt is real history. A late release would hand a replay
    // the delivery it was meant to be refused.
    const claim = ledger.claim(FP);
    if (claim.ok) {
      claim.settle({ success: true, messageId: 'm1' });
      claim.release();
    }
    expect(ledger.peek(FP)).toMatchObject({ state: 'delivered', messageId: 'm1' });
    expect(ledger.claim(FP).ok).toBe(false);
  });

  it('evicts oldest entries beyond the size cap', () => {
    const small = new SendLedger({ windowMs: 60_000, maxEntries: 3 });
    for (const fp of ['a', 'b', 'c', 'd']) {
      const claim = small.claim(fp);
      if (claim.ok) claim.settle({ success: true, messageId: fp });
    }
    expect(small.size()).toBe(3);
    expect(small.peek('a')).toBeUndefined();
    expect(small.peek('d')).toBeDefined();
  });

  it('admits everything when the window is zero', () => {
    const off = new SendLedger({ windowMs: 0 });
    expect(off.enabled).toBe(false);
    const first = off.claim(FP);
    if (first.ok) first.settle({ success: true, messageId: 'm1' });
    expect(off.claim(FP).ok).toBe(true);
  });
});

describe('email-write/Duplicate Send Window Config', () => {
  it('falls back to the default for a missing, empty, malformed, or negative value', () => {
    // A malformed env var must not silently disable a safety guard.
    for (const raw of [undefined, '', '   ', 'forever', 'NaN', '-1']) {
      expect(resolveDuplicateSendWindowMs(raw)).toBe(DEFAULT_DUPLICATE_SEND_WINDOW_MS);
    }
  });

  it('honours an explicit window, including zero', () => {
    expect(resolveDuplicateSendWindowMs('30000')).toBe(30_000);
    expect(resolveDuplicateSendWindowMs('0')).toBe(0);
  });
});

describe('email-write/Default Send Ledger', () => {
  afterEach(() => resetDefaultSendLedger());

  it('is a single process-wide instance, so an unwired embedder is still guarded', () => {
    // The cautionary example is ActionContext.rateLimiter: an optional
    // interface no shipped adapter constructs, so the limit it describes does
    // not exist in the product. This guard must not be opt-in.
    expect(getDefaultSendLedger()).toBe(getDefaultSendLedger());
  });

  it('is rebuilt after a reset', () => {
    const first = getDefaultSendLedger();
    resetDefaultSendLedger();
    expect(getDefaultSendLedger()).not.toBe(first);
  });
});

describe('email-write/Duplicate Send Error', () => {
  it('names the state, the prior message, and the override', () => {
    const inFlight = duplicateSendError({ state: 'in-flight', startedAt: 0 }, 'send_email');
    expect(inFlight.code).toBe(DUPLICATE_SEND_IN_FLIGHT);
    expect(inFlight.message).toContain('allow_duplicate');

    const delivered = duplicateSendError(
      { state: 'delivered', startedAt: 0, settledAt: 1, messageId: 'AAMk-9' },
      'send_email',
    );
    expect(delivered.code).toBe(DUPLICATE_SEND_BLOCKED);
    expect(delivered.message).toContain('AAMk-9');

    const unresolved = duplicateSendError({ state: 'unresolved', startedAt: 0 }, 'reply_to_email');
    expect(unresolved.code).toBe(DUPLICATE_SEND_UNRESOLVED);
    expect(unresolved.message).toContain('Sent Items');
    expect(unresolved.recoverable).toBe(false);
  });
});

describe('email-write/Proven Unsent Codes', () => {
  it('treats only the proven-rejection codes as safe to resend', () => {
    expect(isDeliveryProvenUnsent('INVALID_REQUEST')).toBe(true);
    expect(isDeliveryProvenUnsent('PROVIDER_UNREACHABLE')).toBe(true);
    expect(isDeliveryProvenUnsent('SEND_STATUS_UNKNOWN')).toBe(false);
    expect(isDeliveryProvenUnsent('SCHEDULE_SEND_STATUS_UNKNOWN')).toBe(false);
    expect(isDeliveryProvenUnsent(undefined)).toBe(false);
  });
});
