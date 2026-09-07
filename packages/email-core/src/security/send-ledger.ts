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
  // Graph paths that fail strictly BEFORE the delivery POST. Each was checked
  // at its production site: prepareReplyDraft throws before `/send`
  // (email-graph-provider.ts REPLY_FAILED), attachment size validation runs
  // with zero POSTs, an attachment upload failure leaves an unsent draft, and
  // a scheduled draft with no id was never given a deferred-send time.
  'REPLY_FAILED',
  'ATTACHMENT_TOO_LARGE_FOR_PROVIDER',
  'ATTACHMENT_UPLOAD_FAILED',
  'SCHEDULE_DRAFT_FAILED',
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

/**
 * An attempt plus the identity that makes its callbacks safe.
 *
 * A fingerprint can carry more than one live attempt — `allow_duplicate`
 * deliberately creates a second — so a callback that addressed only the
 * fingerprint would act on whichever attempt happened to occupy the key. That
 * let a slow first attempt's rejection delete a newer attempt's successful
 * record, after which an ordinary replay dispatched again. The claim closure
 * holds the entry object itself, so settle and release can only ever touch the
 * attempt that produced them.
 */
interface LedgerEntry extends SendAttempt {
  readonly id: number;
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
  /**
   * Live attempts per fingerprint, oldest first.
   *
   * A list rather than a single record because `allow_duplicate` legitimately
   * puts two attempts on one fingerprint. Keeping both means a rejected
   * override cannot erase the delivery it was overriding.
   */
  private readonly attempts = new Map<string, LedgerEntry[]>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private nextId = 1;

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
   * `force` is the `allow_duplicate` path. It admits an attempt alongside any
   * existing ones rather than replacing them: the caller authorised THIS send,
   * not the erasure of what came before. If the forced attempt is then
   * rejected, the earlier delivery still blocks an ordinary replay.
   */
  claim(fingerprint: string, opts: { force?: boolean } = {}): ClaimResult {
    if (!this.enabled) {
      return { ok: true, fingerprint, settle: () => {}, release: () => {} };
    }

    this.prune();

    if (!opts.force) {
      const prior = this.strongest(fingerprint);
      if (prior) return { ok: false, fingerprint, prior };
    }

    const entry: LedgerEntry = { id: this.nextId++, state: 'in-flight', startedAt: this.now() };
    this.insert(fingerprint, entry);
    this.evictOverflow();

    return {
      ok: true,
      fingerprint,
      settle: (outcome: SendOutcome) => this.settle(fingerprint, entry, outcome),
      release: () => this.release(fingerprint, entry),
    };
  }

  /**
   * The attempt a colliding claim is told about.
   *
   * Strongest evidence first: a delivered attempt (most recently settled) beats
   * an unresolved one, which beats one still in flight. The caller's question
   * is "did this already go out?", and a delivery elsewhere in the list answers
   * it more decisively than a sibling attempt that has not returned.
   */
  private strongest(fingerprint: string): SendAttempt | undefined {
    const entries = this.attempts.get(fingerprint);
    if (!entries || entries.length === 0) return undefined;
    // Latest first, with the attempt id as tie-break: two attempts can settle
    // inside the same millisecond, and a caller told about the older of two
    // deliveries is told about the wrong message.
    const byState = (state: SendAttemptState): LedgerEntry | undefined => entries
      .filter(e => e.state === state)
      .sort((a, b) => ((b.settledAt ?? b.startedAt) - (a.settledAt ?? a.startedAt)) || (b.id - a.id))[0];
    return byState('delivered') ?? byState('unresolved') ?? byState('in-flight');
  }

  /** Inspect the strongest record without claiming. For tests and diagnostics. */
  peek(fingerprint: string): SendAttempt | undefined {
    this.prune();
    return this.strongest(fingerprint);
  }

  /** Every live attempt on a fingerprint, oldest first. For tests. */
  peekAll(fingerprint: string): readonly SendAttempt[] {
    this.prune();
    return [...(this.attempts.get(fingerprint) ?? [])];
  }

  size(): number {
    this.prune();
    let total = 0;
    for (const entries of this.attempts.values()) total += entries.length;
    return total;
  }

  clear(): void {
    this.attempts.clear();
  }

  private insert(fingerprint: string, entry: LedgerEntry): void {
    const entries = this.attempts.get(fingerprint);
    if (entries) entries.push(entry);
    else this.attempts.set(fingerprint, [entry]);
  }

  private remove(fingerprint: string, entry: LedgerEntry): void {
    const entries = this.attempts.get(fingerprint);
    if (!entries) return;
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (entries.length === 0) this.attempts.delete(fingerprint);
  }

  private settle(fingerprint: string, entry: LedgerEntry, outcome: SendOutcome): void {
    if (isDeliveryProvenUnsent(outcome.errorCode)) {
      // Provably not delivered — this attempt stops blocking. Siblings are
      // untouched: a rejected override must not clear the delivery it overrode.
      this.remove(fingerprint, entry);
      return;
    }

    entry.settledAt = this.now();
    if (outcome.success) {
      entry.state = 'delivered';
      if (outcome.messageId !== undefined) entry.messageId = outcome.messageId;
    } else {
      entry.state = 'unresolved';
    }

    // The attempt may have been pruned or evicted while it was in flight. A
    // success that lands late is still evidence that mail went out, so put it
    // back rather than dropping it; its window now runs from settlement.
    const entries = this.attempts.get(fingerprint);
    if (!entries || !entries.includes(entry)) this.insert(fingerprint, entry);
  }

  private release(fingerprint: string, entry: LedgerEntry): void {
    // Only a reservation that never reached the provider may be withdrawn. A
    // settled attempt is real history, and a late release would hand a replay
    // the delivery it was meant to be refused.
    if (entry.state === 'in-flight') this.remove(fingerprint, entry);
  }

  /**
   * Drop attempts past the window.
   *
   * An in-flight attempt is aged from `startedAt`, so an action that throws
   * between claim and settle stops blocking once the window passes rather than
   * wedging the fingerprint forever. Holding it until then is the fail-closed
   * direction: a throw after dispatch is precisely the ambiguous case.
   */
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [fingerprint, entries] of this.attempts) {
      const live = entries.filter(e => (e.settledAt ?? e.startedAt) > cutoff);
      if (live.length === 0) this.attempts.delete(fingerprint);
      else if (live.length !== entries.length) this.attempts.set(fingerprint, live);
    }
  }

  /**
   * Keep memory bounded by discarding the oldest SETTLED attempts.
   *
   * In-flight attempts are never evicted. Evicting one would drop a
   * reservation covering a send that is on the wire right now, which is the
   * single worst thing this module can do; and refusing a new claim because
   * the ledger is full would block first-ever sends, which is worse still.
   * So a burst of concurrent sends may briefly carry the map past the cap, and
   * those entries age out on the ordinary TTL.
   */
  private evictOverflow(): void {
    while (this.size() > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldest: LedgerEntry | undefined;
      for (const [fingerprint, entries] of this.attempts) {
        for (const entry of entries) {
          if (entry.state === 'in-flight') continue;
          if (!oldest || (entry.settledAt ?? entry.startedAt) < (oldest.settledAt ?? oldest.startedAt)) {
            oldest = entry;
            oldestKey = fingerprint;
          }
        }
      }
      if (!oldest || oldestKey === undefined) return; // nothing evictable — all in flight
      this.remove(oldestKey, oldest);
    }
  }
}

/**
 * A stable id for a provider instance, used as the ledger namespace when the
 * caller supplies no mailbox name.
 *
 * Without this, two mailboxes in one process with no `mailboxName` share the
 * empty key: the second mailbox's first-ever send is refused and handed the
 * FIRST mailbox's message id. A WeakMap keyed on the provider object gives
 * each one its own namespace and holds no reference that would keep a
 * disconnected provider alive.
 *
 * Lifetime assumption: one provider instance means one mailbox. A provider
 * rebuilt for the same mailbox (a reconnect) starts a fresh namespace and
 * loses protection for the window — which is why a caller that knows its
 * mailbox name should always supply it, as the MCP server does.
 */
const providerNamespaces = new WeakMap<object, string>();
let nextProviderNamespace = 1;

export function providerNamespace(provider: object | undefined): string {
  if (!provider) return '';
  let namespace = providerNamespaces.get(provider);
  if (namespace === undefined) {
    namespace = `provider#${nextProviderNamespace++}`;
    providerNamespaces.set(provider, namespace);
  }
  return namespace;
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
