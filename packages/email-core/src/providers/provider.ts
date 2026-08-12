// Capability-based provider interfaces
import type {
  EmailMessage,
  EmailThread,
  ComposeMessage,
  SendResult,
  DraftResult,
  ListOptions,
  ReplyOptions,
  Subscription,
  EmailError,
  ScheduledSend,
  ScheduledSendResult,
} from '../types.js';

export interface EmailReader {
  listMessages(opts: ListOptions): Promise<EmailMessage[]>;
  getMessage(id: string): Promise<EmailMessage>;
  getDraft?(draftId: string): Promise<EmailMessage>;
  searchMessages(query: string, folder?: string, limit?: number, offset?: number): Promise<EmailMessage[]>;
  getThread(messageId: string): Promise<EmailThread>;
}

export interface EmailSender {
  sendMessage(msg: ComposeMessage): Promise<SendResult>;
  replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult>;
  createDraft(msg: ComposeMessage): Promise<DraftResult>;
  sendDraft(draftId: string): Promise<SendResult>;
  createReplyDraft?(messageId: string, body: string, opts?: ReplyOptions): Promise<DraftResult>;
  getDraftReplyStatus?(draftId: string): Promise<DraftReplyStatus>;
  updateDraft?(draftId: string, msg: Partial<ComposeMessage>): Promise<DraftResult>;
}

export type DraftReplyStatus = 'reply' | 'non_reply' | 'indeterminate';

export interface EmailScheduledSender {
  scheduleMessage(msg: ComposeMessage, scheduledSendAt: string): Promise<ScheduledSendResult>;
  scheduleDraft(draftId: string, scheduledSendAt: string): Promise<ScheduledSendResult>;
  listScheduledSends(): Promise<ScheduledSend[]>;
  cancelScheduledSend(messageId: string): Promise<void>;
}

export interface EmailSubscriber {
  subscribe(callback: (msg: EmailMessage) => void): Promise<Subscription>;
  unsubscribe(sub: Subscription): Promise<void>;
}

export interface EmailCategorizer {
  applyLabels(messageId: string, labels: string[]): Promise<void>;
  removeLabels(messageId: string, labels: string[]): Promise<void>;
  setFlag(messageId: string, flagged: boolean): Promise<void>;
  setReadState(messageId: string, isRead: boolean): Promise<void>;
  moveToFolder(messageId: string, folder: string): Promise<string | void>;
  deleteMessage(messageId: string, hard?: boolean): Promise<void>;
}

export interface DownloadedAttachment {
  content: Buffer;
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailAttachmentHandler {
  listAttachments(messageId: string): Promise<import('../types.js').EmailAttachment[]>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment>;
}

export interface EmailFolder {
  id: string;
  displayName: string;
  path: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
  isHidden?: boolean;
  [key: string]: unknown;
}

export interface EmailFolderManager {
  listFolders(): Promise<EmailFolder[]>;
  createFolder(displayName: string, parentFolder?: string): Promise<EmailFolder>;
  deleteFolder(folder: string): Promise<void>;
}

export interface InboxRule {
  id?: string;
  displayName?: string;
  sequence?: number;
  isEnabled?: boolean;
  hasError?: boolean;
  isReadOnly?: boolean;
  conditions?: Record<string, unknown>;
  exceptions?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CreateInboxRule {
  displayName: string;
  sequence?: number;
  isEnabled?: boolean;
  conditions: Record<string, unknown>;
  exceptions?: Record<string, unknown>;
  actions: Record<string, unknown>;
}

export interface EmailRuleManager {
  listInboxRules(): Promise<InboxRule[]>;
  createInboxRule(rule: CreateInboxRule): Promise<InboxRule>;
  deleteInboxRule(id: string): Promise<void>;
}

// Combined provider type — providers implement what they support
export type EmailProvider = EmailReader
  & EmailSender
  & Partial<EmailScheduledSender>
  & Partial<EmailSubscriber>
  & Partial<EmailCategorizer>
  & Partial<EmailAttachmentHandler>
  & Partial<EmailFolderManager>
  & Partial<EmailRuleManager>;

// Provider metadata for registration
export interface ProviderInfo {
  name: string;
  displayName: string;
  // 'attachments' covers inbound (list/download); 'outbound-attachments'
  // covers attaching files to sent mail / drafts. Both Graph and Gmail
  // support both. Note: no provider currently exports a ProviderInfo value —
  // this is a forward-compat type surface; wiring a real metadata surface
  // that declares these is a follow-up.
  capabilities: ('read' | 'send' | 'scheduled-send' | 'subscribe' | 'categorize' | 'attachments' | 'outbound-attachments' | 'folders' | 'rules')[];
}

// Error normalization
export function normalizeProviderError(
  err: unknown,
  provider: string,
): EmailError {
  if (isProviderError(err)) {
    return {
      code: err.code,
      message: err.message,
      provider,
      recoverable: err.recoverable,
      retryAfter: err.retryAfter,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'UNKNOWN_ERROR',
    message,
    provider,
    recoverable: false,
  };
}

export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public provider: string,
    public recoverable: boolean,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Structural guard for ProviderError.
 *
 * `instanceof` is NOT sufficient here. ProviderError is defined in email-core
 * but constructed in the provider packages, which depend on email-core by
 * semver range. A duplicate install (two copies of email-core in the tree)
 * makes `err instanceof ProviderError` silently false, which would collapse
 * every normalized provider error back into the caller's fallback code —
 * reintroducing exactly the defect this normalization exists to fix, and doing
 * it invisibly. `auth.ts` already carries the same structural fallback for
 * GraphApiError for the same reason.
 */
export function isProviderError(err: unknown): err is ProviderError {
  if (err instanceof ProviderError) return true;
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  return (
    obj.name === 'ProviderError' &&
    typeof obj.code === 'string' &&
    typeof obj.recoverable === 'boolean'
  );
}

/**
 * What kind of operation produced an error. Delivery is called out separately
 * because it is the only kind where re-issuing a request can duplicate a
 * user-visible side effect (a sent email).
 */
export type OperationKind = 'idempotent-read' | 'idempotent-write' | 'delivery';

/**
 * Where a transport failure occurred relative to the request being written.
 *
 * `connect-failed` means we can PROVE no request bytes reached the origin, so
 * the operation definitely did not happen. `dispatched-or-unknown` means the
 * request may have been written and acted upon — for delivery that is the
 * difference between "not sent" and "may have been sent".
 *
 * A third category — a purely local failure before any dispatch was attempted
 * (payload construction, recipient parsing, attachment encoding) — is not
 * represented here because it is enforced structurally: providers wrap ONLY
 * the dispatch call, so construction errors never reach this function.
 */
export type DispatchStage = 'connect-failed' | 'dispatched-or-unknown';

/**
 * Error codes that can only arise before any request bytes are written.
 *
 * DNS resolution and TCP connect strictly precede the HTTP request; a TLS
 * handshake failure likewise aborts before the request is sent. Every entry
 * here is an exact code — never match on message text, which is unstable
 * across Node and undici versions.
 */
const PRE_DISPATCH_ERROR_CODES: ReadonlySet<string> = new Set([
  // DNS
  'ENOTFOUND', 'EAI_AGAIN',
  // TCP connect
  'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT',
  // TLS handshake — aborts before the HTTP request is written
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/**
 * Error codes that are known to be ambiguous — the request may already have
 * been written and acted upon. Listed explicitly so that a chain containing
 * one of these is never downgraded to `connect-failed` by an accompanying
 * pre-dispatch code.
 *
 * ETIMEDOUT is here deliberately: Node defines it as a connect OR send
 * timeout, so the code alone cannot prove which. ECONNRESET means an
 * ESTABLISHED connection was closed, which is genuinely undecidable.
 */
const AMBIGUOUS_ERROR_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_RESPONSE_STATUS_CODE', 'UND_ERR_ABORTED',
  'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE',
]);

const MAX_CAUSE_DEPTH = 5;

/**
 * Classify a thrown transport error by walking the `cause` chain.
 *
 * Node's global fetch (undici) rejects with a generic `TypeError: fetch failed`
 * whose real cause hangs off `.cause`; googleapis/Gaxios wraps again. So the
 * code we need is rarely on the top-level error.
 *
 * Returns `connect-failed` ONLY when a recognized pre-dispatch code is present
 * and no ambiguous code appears anywhere in the chain. Everything else —
 * including an unrecognized code, no code at all, or a non-Error throw —
 * returns `dispatched-or-unknown`. Ambiguity is the safe default: mistaking
 * "may have been sent" for "not sent" is the failure mode that duplicates
 * email, so it must never happen by accident.
 */
export function classifyTransportError(err: unknown): DispatchStage {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (typeof current !== 'object') break;
    const obj = current as Record<string, unknown>;
    for (const key of ['code', 'errno'] as const) {
      const value = obj[key];
      if (typeof value === 'string') codes.push(value);
    }
    current = obj.cause;
  }

  if (codes.some(code => AMBIGUOUS_ERROR_CODES.has(code))) return 'dispatched-or-unknown';
  if (codes.some(code => PRE_DISPATCH_ERROR_CODES.has(code))) return 'connect-failed';
  return 'dispatched-or-unknown';
}

/**
 * Parse a Retry-After header value into seconds.
 *
 * Accepts both forms defined by RFC 9110: delta-seconds and an HTTP-date.
 * Returns undefined for anything unparseable or in the past, so a caller can
 * fall back to its own backoff rather than waiting on a bad value.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  const seconds = Math.ceil((parsed - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/** Code emitted when a delivery may or may not have been accepted. */
export const SEND_STATUS_UNKNOWN = 'SEND_STATUS_UNKNOWN';

export interface ClassifiedFailure {
  code: string;
  /** True only when re-issuing the request is SAFE, not merely when it might succeed. */
  recoverable: boolean;
  retryAfter?: number;
}

/**
 * Map an HTTP status to a normalized failure.
 *
 * The dividing line: a 4xx proves the service received AND rejected the
 * request, so the operation definitely did not happen — terminal. A 5xx proves
 * receipt but nothing about whether the service acted, so for delivery it is
 * ambiguous. This is the same line `scheduledDraftSendFailure` already draws
 * for scheduled sends.
 *
 * Note 429 on a delivery operation: `retryAfter` is populated as advice to the
 * human, but `recoverable` stays false so that no machine layer re-issues the
 * send. The status proves the request was rejected, so resending is safe — but
 * that decision belongs to the user, not to an automatic retry.
 */
export function classifyHttpStatus(
  status: number,
  operation: OperationKind,
  opts: { retryAfter?: number } = {},
): ClassifiedFailure {
  const isDelivery = operation === 'delivery';
  const { retryAfter } = opts;

  if (status === 429) {
    return { code: 'RATE_LIMITED', recoverable: !isDelivery, retryAfter };
  }
  if (status >= 400 && status < 500) {
    switch (status) {
      case 400:
      case 422:
        return { code: 'INVALID_REQUEST', recoverable: false };
      case 401:
        return { code: 'AUTH_REQUIRED', recoverable: false };
      case 403:
        return { code: 'PERMISSION_DENIED', recoverable: false };
      case 404:
        return { code: 'NOT_FOUND', recoverable: false };
      case 409:
        return { code: 'CONFLICT', recoverable: false };
      case 413:
        return { code: 'PAYLOAD_TOO_LARGE', recoverable: false };
      default:
        return { code: 'PROVIDER_REJECTED', recoverable: false };
    }
  }
  // 5xx and anything else: the origin received the request but its outcome is
  // unknown. Safe to retry a read; never safe to re-issue a delivery.
  return isDelivery
    ? { code: SEND_STATUS_UNKNOWN, recoverable: false, retryAfter }
    : { code: 'PROVIDER_ERROR', recoverable: true, retryAfter };
}

/**
 * Whether an error may be retried for a given operation kind.
 *
 * Delivery is never retryable, unconditionally — not because every delivery
 * failure is ambiguous, but because this is the last line of defence against
 * a future caller wrapping a send in withRetry again. Belt as well as braces:
 * providers also refuse to mark delivery failures recoverable.
 */
export function isRetryable(err: unknown, operation: OperationKind): boolean {
  if (operation === 'delivery') return false;
  return isProviderError(err) && err.recoverable;
}

// Thrown by providers when an attachment cannot be downloaded by this
// implementation — e.g. Microsoft Graph item/reference attachments, which
// require the /$value raw-bytes path. The download_attachment action remaps
// this to a typed { code: 'NOT_SUPPORTED' } result instead of letting it
// surface as PROVIDER_UNAVAILABLE.
export class AttachmentNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentNotSupportedError';
  }
}

// Thrown by providers when the requested attachment id does not exist on the
// message (e.g. Graph 404 on the bytes call after a race deletion). The
// download_attachment action remaps this to { code: 'ATTACHMENT_NOT_FOUND' }
// so race-deleted attachments surface with the same code as a stale id.
export class AttachmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentNotFoundError';
  }
}

// Provider registry for dynamic discovery
const providerRegistry = new Map<string, () => Promise<EmailProvider>>();

export function registerProvider(name: string, factory: () => Promise<EmailProvider>): void {
  providerRegistry.set(name, factory);
}

export function getRegisteredProviders(): string[] {
  return [...providerRegistry.keys()];
}

export async function createProvider(name: string): Promise<EmailProvider> {
  const factory = providerRegistry.get(name);
  if (!factory) {
    throw new ProviderError(
      'PROVIDER_NOT_FOUND',
      `Provider '${name}' not available. Install: npm install @usejunior/provider-${name}`,
      name,
      false,
    );
  }
  return factory();
}

// Dynamic discovery of installed providers
export async function discoverProviders(): Promise<string[]> {
  const providerPackages = ['microsoft', 'gmail'];
  const discovered: string[] = [];

  for (const name of providerPackages) {
    try {
      await import(`@usejunior/provider-${name}`);
      discovered.push(name);
    } catch {
      // Provider not installed — skip silently
    }
  }

  return discovered;
}

/**
 * Retry with exponential backoff, for operations that are safe to re-issue.
 *
 * The gate is allowlist, not denylist: an error is retried only when it is a
 * ProviderError explicitly marked recoverable. It previously read
 * `err instanceof ProviderError && !err.recoverable → throw`, which retried
 * EVERYTHING else — plain Errors, programming bugs, and unclassified provider
 * errors alike. That inversion is what let a deterministic Graph 400 be
 * re-issued four times, and it contradicted the function's own comment.
 *
 * `operation` defaults to 'idempotent-read'. Passing 'delivery' makes this a
 * single attempt by construction — see isRetryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    operation?: OperationKind;
  } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 16000;
  const operation = opts.operation ?? 'idempotent-read';

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) break;
      if (!isRetryable(err, operation)) throw err;

      // A provider-supplied Retry-After is a floor, not a ceiling: honour it
      // when it exceeds our own backoff, so we do not hammer a throttled API.
      const backoff = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const retryAfterMs = isProviderError(err) && typeof err.retryAfter === 'number'
        ? err.retryAfter * 1000
        : 0;
      const delay = Math.max(backoff, retryAfterMs);
      const jitter = retryAfterMs > backoff ? delay : delay * (0.5 + Math.random() * 0.5);
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  throw lastError;
}

// Authentication lifecycle interface
export interface AuthManager {
  connect(credentials: Record<string, string>): Promise<void>;
  refresh(): Promise<void>;
  disconnect(): Promise<void>;
  isTokenExpired(): boolean;
}

// Wrapper that auto-refreshes tokens
export async function withAutoRefresh<T>(
  authManager: AuthManager,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // If token expired, refresh and retry
    if (authManager.isTokenExpired()) {
      await authManager.refresh();
      return await fn();
    }
    throw err;
  }
}
