// Duplicate-delivery guard — the caller-replay half of delivery safety.
//
// `isRetryable(err, 'delivery')` and the single-attempt dispatch in the three
// delivery actions guarantee that THIS LIBRARY never re-issues a send. They
// guarantee nothing about the caller. An agent whose tool result was lost —
// context compaction, a dropped transport, a supervisor restarting the turn, a
// human retrying something that looked stuck — replays the same approved
// instruction, and the second call is indistinguishable from a first one.
//
// The ledger supplies the missing state: a record, written BEFORE dispatch and
// settled after, that says "a delivery with exactly these bytes was attempted."
// A colliding claim short-circuits before the provider is touched.
//
// LIMITATION, stated rather than papered over: this is per-process and in
// memory. It closes the replay window that actually occurs — a retry inside a
// live server — and does not survive a restart of that server. Cross-process
// durability needs a persisted store and is deliberately not attempted here.
import { createHash } from 'node:crypto';
import type { EmailAddress, OutboundAttachment } from '../types.js';

export const DUPLICATE_SEND_WINDOW_ENV = 'AGENT_EMAIL_DUPLICATE_SEND_WINDOW_MS';

/**
 * How long a settled attempt keeps blocking an identical one.
 *
 * Fifteen minutes covers the realistic replay distance (a retried turn, a
 * resumed loop) without blocking the legitimate case of the same automated
 * message going out on a schedule, which is normally further apart. Operators
 * who disagree have the env var; a caller who disagrees for one message has
 * `allow_duplicate`.
 */
export const DEFAULT_DUPLICATE_SEND_WINDOW_MS = 15 * 60 * 1000;

/** Ledger size cap. Oldest-first eviction keeps memory bounded. */
export const MAX_SEND_LEDGER_ENTRIES = 512;

export const DUPLICATE_SEND_IN_FLIGHT = 'DUPLICATE_SEND_IN_FLIGHT';
export const DUPLICATE_SEND_BLOCKED = 'DUPLICATE_SEND_BLOCKED';
export const DUPLICATE_SEND_UNRESOLVED = 'DUPLICATE_SEND_UNRESOLVED';

/**
 * Outcome codes that PROVE the provider did not deliver, and therefore release
 * the fingerprint so a resend is permitted.
 *
 * This is an allowlist, not a denylist, and the asymmetry is the whole point.
 * A false hold costs a caller one blocked resend and prints the override flag
 * in the error. A false release costs a duplicate in someone's inbox, which is
 * the bug this module exists to prevent. Anything not named here — including a
 * code some future provider invents — is held as unresolved.
 *
 * Membership follows the same line `classifyHttpStatus` already draws: a 4xx
 * proves the service received AND rejected the request, and a connect-failure
 * proves no request bytes were written.
 */
export const DELIVERY_PROVEN_UNSENT_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMITED',        // 429 — rejected, not queued
  'INVALID_REQUEST',     // 400 / 422
  'AUTH_REQUIRED',       // 401
  'PERMISSION_DENIED',   // 403
  'NOT_FOUND',           // 404
  'CONFLICT',            // 409
  'PAYLOAD_TOO_LARGE',   // 413
  'PROVIDER_REJECTED',   // other 4xx
  'PROVIDER_UNREACHABLE', // connect-failed: provably no bytes on the wire
  'SCHEDULE_SEND_FAILED', // scheduling's non-ambiguous variant
  'NOT_SUPPORTED',       // capability rejection, never dispatched
  'ALLOWLIST_BLOCKED',   // refused before dispatch
]);

/** Whether a failure code proves nothing was delivered. */
export function isDeliveryProvenUnsent(code: string | undefined): boolean {
  return code !== undefined && DELIVERY_PROVEN_UNSENT_CODES.has(code);
}

export type SendAttemptState = 'in-flight' | 'delivered' | 'unresolved';

export interface SendAttempt {
  state: SendAttemptState;
  /** Epoch ms when the attempt was claimed. */
  startedAt: number;
  /** Epoch ms when the attempt settled, absent while in flight. */
  settledAt?: number;
  /** Provider message id, present only for a delivered attempt. */
  messageId?: string;
}

export interface SendOutcome {
  success: boolean;
  messageId?: string;
  errorCode?: string;
}

/** A successful claim. Exactly one of settle/release should be called. */
export interface SendClaim {
  ok: true;
  fingerprint: string;
  /** Record the terminal state, releasing the fingerprint if proven unsent. */
  settle: (outcome: SendOutcome) => void;
  /**
   * Drop the reservation without recording an attempt.
   *
   * For a bail-out AFTER the claim but BEFORE the provider is touched — a draft
   * that could not be read, an empty recipient list, an allowlist refusal. The
   * message provably did not go out, so it must not block the corrected call.
   * Never call this once the provider has been invoked: that is `settle`'s job,
   * and the difference is whether a duplicate is possible.
   */
  release: () => void;
}

export interface DuplicateSend {
  ok: false;
  fingerprint: string;
  prior: SendAttempt;
}

export type ClaimResult = SendClaim | DuplicateSend;

/** Everything that determines what a recipient would actually receive. */
export interface SendFingerprintInput {
  /** Action name, so a reply and a fresh send never collide. */
  action: string;
  mailbox?: string | undefined;
  to?: readonly EmailAddress[] | undefined;
  cc?: readonly EmailAddress[] | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  bodyHtml?: string | undefined;
  attachments?: readonly OutboundAttachment[] | undefined;
  scheduledSendAt?: string | undefined;
  /** Parent message for a reply. */
  parentMessageId?: string | undefined;
  /** Draft being sent, for send_draft. */
  draftId?: string | undefined;
  replyAll?: boolean | undefined;
}

function normalizeAddresses(addresses: readonly EmailAddress[] | undefined): string[] {
  if (!addresses) return [];
  // Address identity is the mailbox, not the display name: "Jane <j@x>" and
  // "j@x" deliver to the same person, and ordering is not meaningful.
  return [...new Set(addresses.map(a => a.email.trim().toLowerCase()))].sort();
}

function digestAttachments(attachments: readonly OutboundAttachment[] | undefined): string[] {
  if (!attachments) return [];
  // Content is digested, never stored: the ledger must not become a copy of
  // outbound mail sitting in memory.
  return attachments
    .map(a => [
      a.filename,
      a.mimeType,
      String(a.content.byteLength),
      createHash('sha256').update(a.content).digest('hex'),
    ].join(':'))
    .sort();
}

/**
 * Stable digest of a delivery.
 *
 * Body and bodyHtml are fingerprinted post-render and post-truncation by the
 * callers, so the digest describes the bytes that would leave the process
 * rather than the caller's input.
 */
export function computeSendFingerprint(input: SendFingerprintInput): string {
  const canonical = JSON.stringify([
    input.action,
    input.mailbox ?? '',
    normalizeAddresses(input.to),
    normalizeAddresses(input.cc),
    input.subject ?? '',
    input.body ?? '',
    input.bodyHtml ?? '',
    digestAttachments(input.attachments),
    input.scheduledSendAt ?? '',
    input.parentMessageId ?? '',
    input.draftId ?? '',
    input.replyAll ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface SendLedgerOptions {
  /** Retention window in ms. `0` disables the guard entirely. */
  windowMs?: number;
  maxEntries?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Read the operator-configured window.
 *
 * Read at construction rather than cached at module load so a test or an
 * embedder can set the variable before building a ledger. An unparseable or
 * negative value falls back to the default: a malformed env var must not
 * silently disable a safety guard.
 */
export function resolveDuplicateSendWindowMs(
  raw: string | undefined = process.env[DUPLICATE_SEND_WINDOW_ENV],
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DUPLICATE_SEND_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DUPLICATE_SEND_WINDOW_MS;
  return parsed;
}

export class SendLedger {
  private readonly attempts = new Map<string, SendAttempt>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: SendLedgerOptions = {}) {
    this.windowMs = opts.windowMs ?? resolveDuplicateSendWindowMs();
    this.maxEntries = opts.maxEntries ?? MAX_SEND_LEDGER_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  /** True when the operator disabled the guard. */
  get enabled(): boolean {
    return this.windowMs > 0;
  }

  /**
   * Reserve a fingerprint ahead of dispatch.
   *
   * `force` is the `allow_duplicate` path: it discards any prior record and
   * claims afresh, so the deliberate duplicate is still protected against ITS
   * own replay.
   */
  claim(fingerprint: string, opts: { force?: boolean } = {}): ClaimResult {
    if (!this.enabled) {
      return { ok: true, fingerprint, settle: () => {}, release: () => {} };
    }

    this.prune();

    if (!opts.force) {
      const prior = this.attempts.get(fingerprint);
      if (prior) return { ok: false, fingerprint, prior };
    }

    const attempt: SendAttempt = { state: 'in-flight', startedAt: this.now() };
    this.attempts.delete(fingerprint); // re-insert so eviction order is recency
    this.attempts.set(fingerprint, attempt);
    this.evictOverflow();

    return {
      ok: true,
      fingerprint,
      settle: (outcome: SendOutcome) => this.settle(fingerprint, outcome),
      release: () => {
        // Only drop a record still in flight: a settled attempt is real
        // history, and a late release would reopen it to replay.
        if (this.attempts.get(fingerprint)?.state === 'in-flight') {
          this.attempts.delete(fingerprint);
        }
      },
    };
  }

  /** Inspect a record without claiming. Intended for tests and diagnostics. */
  peek(fingerprint: string): SendAttempt | undefined {
    this.prune();
    return this.attempts.get(fingerprint);
  }

  size(): number {
    this.prune();
    return this.attempts.size;
  }

  clear(): void {
    this.attempts.clear();
  }

  private settle(fingerprint: string, outcome: SendOutcome): void {
    const attempt = this.attempts.get(fingerprint);
    if (!attempt) return; // pruned mid-flight; nothing to settle

    if (outcome.success) {
      attempt.state = 'delivered';
      attempt.settledAt = this.now();
      if (outcome.messageId !== undefined) attempt.messageId = outcome.messageId;
      return;
    }

    if (isDeliveryProvenUnsent(outcome.errorCode)) {
      // Provably not delivered — resending is safe, so stop blocking it.
      this.attempts.delete(fingerprint);
      return;
    }

    attempt.state = 'unresolved';
    attempt.settledAt = this.now();
  }

  /**
   * Drop records past the window.
   *
   * An in-flight record is aged from `startedAt`, so an action that throws
   * between claim and settle stops blocking once the window passes rather than
   * wedging the fingerprint forever. Holding it until then is the fail-closed
   * direction: a throw after dispatch is precisely the ambiguous case.
   */
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [fingerprint, attempt] of this.attempts) {
      if ((attempt.settledAt ?? attempt.startedAt) <= cutoff) {
        this.attempts.delete(fingerprint);
      }
    }
  }

  private evictOverflow(): void {
    while (this.attempts.size > this.maxEntries) {
      const oldest = this.attempts.keys().next();
      if (oldest.done) return;
      this.attempts.delete(oldest.value);
    }
  }
}

let defaultLedger: SendLedger | undefined;

/**
 * The ledger used when an ActionContext supplies none.
 *
 * Deliberately a default rather than an opt-in. `ActionContext.rateLimiter` is
 * the cautionary example in this codebase: an optional injected interface that
 * no shipped adapter ever constructs, so the limit it describes does not exist
 * in the product. A duplicate guard that an embedder has to remember to wire is
 * a duplicate guard that is off.
 */
export function getDefaultSendLedger(): SendLedger {
  defaultLedger ??= new SendLedger();
  return defaultLedger;
}

/** Drop the default ledger (tests, and any embedder re-reading the env). */
export function resetDefaultSendLedger(): void {
  defaultLedger = undefined;
}

export interface DuplicateSendError {
  code: string;
  message: string;
  recoverable: false;
}

/**
 * Build the refusal for a colliding claim.
 *
 * The guidance rides in the message string because the action result has no
 * separate guidance field — the same convention the Graph delivery errors use.
 * Each state gets different advice because the caller's next move differs:
 * wait, stop, or escalate to a human who can look in Sent Items.
 */
export function duplicateSendError(prior: SendAttempt, actionName: string): DuplicateSendError {
  const override = `Pass allow_duplicate: true to send it anyway.`;
  switch (prior.state) {
    case 'in-flight':
      return {
        code: DUPLICATE_SEND_IN_FLIGHT,
        message:
          `An identical ${actionName} is already in flight and has not returned. `
          + `Not dispatching a second copy. Wait for the first call to complete. `
          + override,
        recoverable: false,
      };
    case 'delivered':
      return {
        code: DUPLICATE_SEND_BLOCKED,
        message:
          `An identical ${actionName} was already delivered`
          + (prior.messageId ? ` as message ${prior.messageId}` : '')
          + `. Not dispatching a duplicate. ${override}`,
        recoverable: false,
      };
    case 'unresolved':
      return {
        code: DUPLICATE_SEND_UNRESOLVED,
        message:
          `An identical ${actionName} was already attempted and its outcome is unknown — `
          + `it may have been delivered. Check Sent Items before resending. ${override}`,
        recoverable: false,
      };
  }
}
