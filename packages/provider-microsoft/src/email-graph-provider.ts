// GraphEmailProvider — Microsoft Graph API email provider
import type {
  EmailAddress,
  EmailAttachment,
  EmailMessage,
  EmailThread,
  ComposeMessage,
  OutboundAttachment,
  SendResult,
  DraftResult,
  DraftSnapshot,
  EmailError,
  ListOptions,
  ReplyOptions,
  EmailReader,
  EmailSender,
  EmailCategorizer,
  EmailAttachmentHandler,
  EmailFolderManager,
  EmailRuleManager,
  EmailFolder,
  InboxRule,
  CreateInboxRule,
  DownloadedAttachment,
  ScheduledSend,
  ScheduledSendResult,
  EmailScheduledSender,
  DraftReplyStatus,
} from '@usejunior/email-core';
import {
  AttachmentNotSupportedError,
  AttachmentNotFoundError,
  MessageNotFoundError,
  ProviderError,
  classifyHttpStatus,
  classifyTransportError,
  parseRetryAfter,
  SEND_STATUS_UNKNOWN,
  validateScheduledSendAt,
  runScheduledWorkflow,
} from '@usejunior/email-core';

const BODY_SIZE_LIMIT = 3.5 * 1024 * 1024; // 3.5MB
const SUBJECT_MAX_LENGTH = 255;

// Microsoft Graph's inline cap is on the *encoded write request* size, not the
// raw file: a fileAttachment carries the bytes as base64 (≈4/3 expansion)
// inside JSON. Graph rejects requests past ~4MB, so the preflight measures
// base64-encoded size and caps it at 3MB — conservative headroom for the
// JSON envelope and (for inline sends) the message body. Files past this
// use the upload-session flow.
const GRAPH_ENCODED_LIMIT = 3 * 1024 * 1024;
const GRAPH_INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
// Graph requires every non-final upload fragment to be a multiple of 320 KiB.
// Ten units stays below Graph's 4 MiB request ceiling.
const GRAPH_UPLOAD_CHUNK_SIZE = 10 * 320 * 1024;

// Ask Graph to return immutable Outlook resource IDs. They remain valid when a
// message is moved and are materially shorter than the default REST IDs, which
// also makes them safer to round-trip through MCP hosts that redact or shorten
// long high-entropy strings. Graph continues to accept legacy/default IDs in
// request paths, so existing callers do not need a migration.
const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/** base64-encoded byte length of a buffer of `rawBytes` bytes. */
function base64Size(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3);
}

/**
 * Enforce the public per-file contract even when the provider is called
 * directly, bypassing email-core's action validation.
 */
function checkGraphAttachmentLimits(
  attachments: OutboundAttachment[] | undefined,
): EmailError | null {
  if (!attachments || attachments.length === 0) return null;
  for (const att of attachments) {
    if (att.content.length > MAX_ATTACHMENT_SIZE) {
      return {
        code: 'ATTACHMENT_TOO_LARGE',
        message: `Attachment "${att.filename}" is ${att.content.length} bytes; maximum size is 25 MB per attachment.`,
        recoverable: false,
      };
    }
  }
  return null;
}

function needsGraphDraftUpload(attachments: OutboundAttachment[] | undefined): boolean {
  if (!attachments || attachments.length === 0) return false;
  return attachments.reduce((total, att) => total + base64Size(att.content.length), 0) > GRAPH_ENCODED_LIMIT;
}

/**
 * Map an address list to Graph `recipient` resources. Returns `undefined` for a
 * missing list so callers can spread it into a payload without emitting an
 * explicit `null` — on a PATCH that would clear the field rather than leave it
 * untouched.
 */
function toGraphRecipients(
  addrs: EmailAddress[] | undefined,
): Array<{ emailAddress: { address: string; name?: string } }> | undefined {
  return addrs?.map(r => ({ emailAddress: { address: r.email, name: r.name } }));
}

/** Build a Graph `fileAttachment` resource from an OutboundAttachment. */
function toGraphFileAttachment(att: OutboundAttachment): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: att.filename,
    contentType: att.mimeType,
    contentBytes: att.content.toString('base64'),
  };
}

/**
 * Carries a structured attachment error out of prepareReplyDraft, optionally
 * with the id of a draft that was created but could not be completed — so the
 * caller can surface it for inspection/retry instead of orphaning it silently.
 */
class GraphAttachmentError extends Error {
  constructor(public readonly emailError: EmailError, public readonly draftId?: string) {
    super(emailError.message);
    this.name = 'GraphAttachmentError';
  }
}

// Sent message tracking via custom extended property
const TRACKING_PROPERTY = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name AgentEmailTrackingId';
const DRAFT_ORIGIN_PROPERTY = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name AgentEmailDraftOrigin';
const DEFERRED_SEND_PROPERTY = 'SystemTime 0x3FEF';
// Page size for the mailbox-wide scheduled-send scan. Graph accepts up to 1000
// for messages. Measured against a real 1,200-draft mailbox, 500 was the sweet
// spot: 3 pages / ~7.5s, against 13 pages / ~9.2s at 100 and 2 pages / ~8.3s at
// 999 — Graph's per-item cost dominates, so bigger pages stop paying off.
const SCHEDULED_SEND_PAGE_SIZE = 500;

const WELL_KNOWN_FOLDER_ALIASES: Record<string, string> = {
  archive: 'archive',
  archived: 'archive',
  deleted: 'deleteditems',
  deleteditems: 'deleteditems',
  drafts: 'drafts',
  inbox: 'inbox',
  junk: 'junkemail',
  junkemail: 'junkemail',
  outbox: 'outbox',
  sent: 'sentitems',
  sentitems: 'sentitems',
  spam: 'junkemail',
  trash: 'deleteditems',
};

const SYSTEM_FOLDER_NAMES = [
  'archive',
  'clutter',
  'conflicts',
  'conversationhistory',
  'deleteditems',
  'drafts',
  'inbox',
  'junkemail',
  'localfailures',
  'msgfolderroot',
  'outbox',
  'recoverableitemsdeletions',
  'scheduled',
  'searchfolders',
  'sentitems',
  'serverfailures',
  'syncissues',
] as const;

const SYSTEM_FOLDER_NAME_SET = new Set<string>([
  ...SYSTEM_FOLDER_NAMES,
  ...Object.keys(WELL_KNOWN_FOLDER_ALIASES),
]);
const FOLDER_CACHE_TTL_MS = 60_000;
// Cap on Graph requests for a single folder-tree snapshot. Pagination is capped
// per collection, but recursion across a deep/wide mailbox would otherwise
// issue one request per folder — enough to blow the MCP request timeout or trip
// Graph throttling. Exceeding this TRUNCATES the listing rather than failing:
// a partial folder list is still useful, whereas a hard error would break
// list_folders outright on legitimately large mailboxes. Truncated snapshots
// are never cached, so the next call retries from scratch, and name resolution
// refuses to answer from a truncated tree (see resolveFolderId).
const MAX_FOLDER_REQUESTS_PER_SNAPSHOT = 400;
// Filing mail into these is equivalent to the blocked `delete` rule action.
const DESTRUCTIVE_RULE_DESTINATIONS = new Set([
  'deleteditems',
  'recoverableitemsdeletions',
  'scheduled',
  'serverfailures',
  'localfailures',
  'syncissues',
  'conflicts',
]);
// Graph accepts rule action keys case-insensitively; compare normalized keys.
const BLOCKED_RULE_ACTIONS = new Set([
  'forwardto',
  'forwardasattachmentto',
  'redirectto',
  'delete',
]);
// Normalized (lowercased) safe action key -> canonical Graph camelCase key.
// Doubles as the allowlist: a key absent here is rejected. Keys are normalized
// before lookup so `MoveToFolder`/`MOVETOFOLDER` all map to `moveToFolder`.
const CANONICAL_RULE_ACTIONS: Record<string, string> = {
  assigncategories: 'assignCategories',
  copytofolder: 'copyToFolder',
  markasread: 'markAsRead',
  markimportance: 'markImportance',
  movetofolder: 'moveToFolder',
  stopprocessingrules: 'stopProcessingRules',
};
const FOLDER_SELECT = '$select=id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden';

export interface GraphApiClient {
  get(url: string, signal?: AbortSignal): Promise<{ value?: unknown[]; [key: string]: unknown }>;
  post(url: string, body?: unknown): Promise<{ id?: string; [key: string]: unknown }>;
  patch(url: string, body: unknown): Promise<void>;
  delete(url: string): Promise<void>;
  putUploadChunk?(url: string, content: Buffer, start: number, total: number): Promise<void>;
  /** GET a binary body (e.g. `/messages/{id}/$value`). Optional so test doubles need not implement it. */
  getBytes?(url: string): Promise<Buffer>;
}

/** Delta query select fields for efficiency */
const DELTA_SELECT = '$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,isRead,id';
// Attachments are polymorphic: $select against the base type fails for derived-only props.
// `contentId` lives on fileAttachment, not on the abstract attachment base, so it must be
// qualified with the OData type cast or Graph returns HTTP 400.
//   base attachment: https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0
//   fileAttachment:  https://learn.microsoft.com/en-us/graph/api/resources/fileattachment?view=graph-rest-1.0
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId';
// `uniqueBody` is returned only when explicitly selected. Because adding
// `$select=uniqueBody` would narrow Graph's response, list every message field
// consumed by mapGraphMessage and widen the existing getMessage projection.
const MESSAGE_SELECT = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'receivedDateTime',
  'isRead',
  'hasAttachments',
  'body',
  'categories',
  'conversationId',
  'flag',
  'internetMessageId',
  'internetMessageHeaders',
  'uniqueBody',
  // Without this, the explicit projection on getMessage/getThread narrows away
  // the only signal that a message is an unsent draft, and a draft reply reads
  // as though it had already been sent. list/search send no $select, so Graph's
  // default projection already carries it there.
  'isDraft',
].join(',');

// Graph message and attachment IDs are base64url-flavored and routinely contain
// `=`, `+`, `/`, `_`, `-`. Path segments must encode `+`, `/`, and `=` or Graph
// returns 400/404. encodeURIComponent handles all three plus `?`, `#`, `&`.
function encodeGraphPathId(id: string): string {
  return encodeURIComponent(id);
}

/** Result from delta query, including messages and the deltaLink for persistence */
export interface DeltaResult {
  messages: EmailMessage[];
  nextDeltaLink: string;
}

/**
 * Real Graph API client using fetch + Bearer token.
 * Used when connected to a real mailbox via DelegatedAuthManager.
 */
export class RealGraphApiClient implements GraphApiClient {
  private getToken: (signal?: AbortSignal) => Promise<string>;
  private onAuthError?: (signal?: AbortSignal) => Promise<boolean>;

  constructor(getToken: (signal?: AbortSignal) => Promise<string>, onAuthError?: (signal?: AbortSignal) => Promise<boolean>) {
    this.getToken = getToken;
    this.onAuthError = onAuthError;
  }

  /**
   * Build a GraphApiError from a failed response.
   *
   * Retry-After must be read here: the header lives on the Response, which is
   * gone once the body has been consumed.
   */
  private async errorFrom(resp: Response): Promise<GraphApiError> {
    // Defensive on `headers`: if this helper threw, the caller would catch a
    // TypeError instead of a GraphApiError, losing the status — and a terminal
    // 4xx would then be classified as an ambiguous delivery. Failing to read a
    // header must never escalate into "the message may have been sent".
    const retryAfter = parseRetryAfter(resp.headers?.get('retry-after'));
    return new GraphApiError(resp.status, await resp.text(), retryAfter);
  }

  /** Fetch with automatic retry on 401 if onAuthError callback is provided. */
  private async fetchWithAuthRetry(url: string, init: RequestInit): Promise<Response> {
    init.signal?.throwIfAborted();
    const resp = await fetch(url, init);
    if (resp.status === 401 && this.onAuthError) {
      init.signal?.throwIfAborted();
      const ok = await this.onAuthError(init.signal ?? undefined);
      if (ok) {
        const newToken = await this.getToken(init.signal ?? undefined);
        init.signal?.throwIfAborted();
        const retryHeaders = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${newToken}` };
        return fetch(url, { ...init, headers: retryHeaders });
      }
    }
    return resp;
  }

  async get(url: string, signal?: AbortSignal): Promise<{ value?: unknown[]; [key: string]: unknown }> {
    signal?.throwIfAborted();
    const token = await this.getToken(signal);
    signal?.throwIfAborted();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await this.fetchWithAuthRetry(fullUrl, {
      ...(signal ? { signal } : {}),
      headers: { Authorization: `Bearer ${token}`, Prefer: IMMUTABLE_ID_PREFER },
    });
    if (!resp.ok) {
      throw await this.errorFrom(resp);
    }
    return resp.json() as Promise<{ value?: unknown[]; [key: string]: unknown }>;
  }

  async getBytes(url: string): Promise<Buffer> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await this.fetchWithAuthRetry(fullUrl, {
      headers: { Authorization: `Bearer ${token}`, Prefer: IMMUTABLE_ID_PREFER },
    });
    if (!resp.ok) {
      throw await this.errorFrom(resp);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  async post(url: string, body?: unknown): Promise<{ id?: string; [key: string]: unknown }> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Prefer: IMMUTABLE_ID_PREFER,
    };
    const init: RequestInit = { method: 'POST', headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const resp = await this.fetchWithAuthRetry(fullUrl, init);
    // sendMail returns 202 with no body
    if (resp.status === 202) return {};
    if (!resp.ok) {
      throw await this.errorFrom(resp);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) as { id?: string; [key: string]: unknown } : {};
  }

  async patch(url: string, body: unknown): Promise<void> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await this.fetchWithAuthRetry(fullUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: IMMUTABLE_ID_PREFER,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw await this.errorFrom(resp);
    }
  }

  async delete(url: string): Promise<void> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await this.fetchWithAuthRetry(fullUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Prefer: IMMUTABLE_ID_PREFER },
    });
    if (!resp.ok) {
      throw await this.errorFrom(resp);
    }
  }

  async putUploadChunk(url: string, content: Buffer, start: number, total: number): Promise<void> {
    const end = start + content.length - 1;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Length': String(content.length),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });
    if (!resp.ok) throw await this.errorFrom(resp);
  }
}

export class GraphApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    /**
     * Seconds from a Retry-After header, when Graph sent one. Captured at the
     * client because the header lives on the Response, which is discarded as
     * soon as the body is read.
     */
    public retryAfterSeconds?: number,
  ) {
    super(`Graph API error ${status}: ${body.slice(0, 200)}`);
    this.name = 'GraphApiError';
  }
}

/**
 * Classify a Graph failure on a DELIVERY operation (sendMail, reply send,
 * draft send).
 *
 * `ambiguous` is the load-bearing bit: it means Graph may already have
 * accepted the message, so a caller must not resend without checking. A 4xx
 * proves Graph rejected the request, so nothing was delivered; a 5xx proves
 * only that Graph received it. A transport failure is ambiguous unless we can
 * prove no request bytes were written.
 */
function classifyGraphDelivery(err: unknown): {
  code: string;
  recoverable: boolean;
  retryAfter?: number;
  ambiguous: boolean;
  detail: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof GraphApiError) {
    const classified = classifyHttpStatus(err.status, 'delivery', {
      retryAfter: err.retryAfterSeconds,
    });
    return { ...classified, ambiguous: classified.code === SEND_STATUS_UNKNOWN, detail };
  }
  if (classifyTransportError(err) === 'connect-failed') {
    return { code: 'PROVIDER_UNREACHABLE', recoverable: false, ambiguous: false, detail };
  }
  return { code: SEND_STATUS_UNKNOWN, recoverable: false, ambiguous: true, detail };
}

/**
 * Build the EmailError for a failed delivery.
 *
 * The message string carries the guidance because the structured action result
 * has no separate guidance field. Publishing an MCP output schema makes the
 * existing fields machine-readable; it does not create a new place for recovery
 * advice. So the ambiguous wording must name a concrete artifact the caller can
 * inspect, and must say plainly not to resend. Wording mirrors the
 * scheduled-send path so the two families read alike.
 */
function graphDeliveryError(
  err: unknown,
  guidance: { ambiguous: string; terminal: string },
): EmailError {
  const failure = classifyGraphDelivery(err);
  return {
    code: failure.code,
    message: `${failure.ambiguous ? guidance.ambiguous : guidance.terminal} ${failure.detail}`,
    provider: 'microsoft',
    recoverable: failure.recoverable,
    ...(failure.retryAfter !== undefined ? { retryAfter: failure.retryAfter } : {}),
  };
}

type FolderSnapshot = { folders: EmailFolder[]; truncated: boolean };

type FolderCacheState<T> =
  | { kind: 'empty' }
  | { kind: 'loading'; generation: number; promise: Promise<T> }
  | { kind: 'ready'; expiresAt: number; data: T };

/** Process-local single-flight cache; invalidated completions must retry. */
class FolderCache<T> {
  private generation = 0;
  private state: FolderCacheState<T> = { kind: 'empty' };

  invalidate(): void {
    this.generation += 1;
    this.state = { kind: 'empty' };
  }

  async get(load: () => Promise<T>, complete: (data: T) => boolean, fresh = false): Promise<T> {
    // Fresh validation bypasses a completed snapshot, but joins an active load.
    // Only a completed structural mutation advances the generation.
    if (fresh && this.state.kind === 'ready') this.state = { kind: 'empty' };
    for (;;) {
      if (this.state.kind === 'ready' && this.state.expiresAt > Date.now()) {
        return this.state.data;
      }
      if (this.state.kind !== 'loading') {
        // Defer the loader until the shared state is installed, including when
        // a loader throws synchronously before making its first request.
        this.state = {
          kind: 'loading', generation: this.generation,
          promise: Promise.resolve().then(load),
        };
      }
      const loading = this.state;
      let data: T;
      try {
        data = await loading.promise;
      } catch (err) {
        if (this.state === loading) this.state = { kind: 'empty' };
        if (loading.generation !== this.generation) continue;
        throw err;
      }
      // A structural mutation can finish while Graph is still traversing.
      // Neither publish nor return that generation as the current snapshot.
      if (loading.generation !== this.generation) continue;
      if (this.state === loading) {
        this.state = complete(data)
          ? { kind: 'ready', expiresAt: Date.now() + FOLDER_CACHE_TTL_MS, data }
          : { kind: 'empty' };
      }
      return data;
    }
  }
}

export class GraphEmailProvider implements EmailReader, EmailSender, EmailScheduledSender, EmailCategorizer, EmailAttachmentHandler, EmailFolderManager, EmailRuleManager {
  private client: GraphApiClient;
  private basePath: string;
  private folderCache = new FolderCache<FolderSnapshot>();
  private systemFolderIdsCache = new FolderCache<Map<string, string>>();

  constructor(client: GraphApiClient, userId = 'me') {
    this.client = client;
    // For delegated auth, use /me/. For app-only, use /users/{id}/.
    this.basePath = userId === 'me' ? '/me' : `/users/${userId}`;
  }

  async listMessages(opts: ListOptions): Promise<EmailMessage[]> {
    const params = new URLSearchParams();
    params.set('$top', String(opts.limit ?? 25));
    if (opts.offset) params.set('$skip', String(opts.offset));
    params.set('$orderby', 'receivedDateTime desc');

    const filters: string[] = [];
    if (opts.unread) filters.push('isRead eq false');
    if (opts.from) filters.push(`from/emailAddress/address eq '${opts.from}'`);
    if (filters.length > 0) params.set('$filter', filters.join(' and '));

    const folder = normalizeFolderId(opts.folder ?? 'inbox');
    const url = `${this.basePath}/mailFolders/${encodeGraphPathId(folder)}/messages?${params}`;
    const response = await this.client.get(url);
    return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const encodedId = encodeGraphPathId(id);
    const expandedUrl = `${this.basePath}/messages/${encodedId}?$select=${MESSAGE_SELECT}&$expand=attachments($select=${ATTACHMENT_SELECT})`;

    try {
      const response = await this.client.get(expandedUrl) as unknown as GraphMessage;
      return mapGraphMessage(response);
    } catch (err) {
      // Some mailboxes reject nested $select inside $expand; fall back to a
      // second metadata-only attachments request rather than dropping data.
      if (!(err instanceof GraphApiError) || err.status !== 400) throw err;
    }

    const message = await this.client.get(
      `${this.basePath}/messages/${encodedId}?$select=${MESSAGE_SELECT}`,
    ) as unknown as GraphMessage;
    const attachments = await this.client.get(
      `${this.basePath}/messages/${encodedId}/attachments?$select=${ATTACHMENT_SELECT}`,
    );

    return mapGraphMessage({
      ...message,
      attachments: ((attachments.value ?? []) as GraphAttachment[]),
    });
  }

  async searchMessages(query: string, folder?: string, limit?: number, offset?: number): Promise<EmailMessage[]> {
    if (!query || !query.trim()) return [];

    const params = new URLSearchParams();
    params.set('$search', `"${query}"`);
    params.set('$top', String(limit ?? 50));
    if (offset) params.set('$skip', String(offset));
    const normalizedFolder = folder ? normalizeFolderId(folder) : undefined;
    const base = normalizedFolder
      ? `${this.basePath}/mailFolders/${encodeGraphPathId(normalizedFolder)}/messages`
      : `${this.basePath}/messages`;

    try {
      const response = await this.client.get(`${base}?${params}`);
      return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
    } catch (err) {
      // On HTTP 400 (syntax error), retry with simplified keywords
      if (err instanceof GraphApiError && err.status === 400) {
        const simplified = simplifySearchQuery(query);
        if (simplified && simplified !== query) {
          const retryParams = new URLSearchParams();
          retryParams.set('$search', `"${simplified}"`);
          retryParams.set('$top', String(limit ?? 50));
          if (offset) retryParams.set('$skip', String(offset));
          const response = await this.client.get(`${base}?${retryParams}`);
          return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
        }
      }
      throw err;
    }
  }

  async getThread(messageId: string): Promise<EmailThread> {
    const message = await this.getMessage(messageId);
    const conversationId = message.conversationId;

    if (conversationId) {
      const params = new URLSearchParams();
      params.set('$filter', `conversationId eq '${conversationId}'`);
      // No `$orderby`: Graph rejects (`InefficientFilter`) an `$orderby` on a
      // property that isn't also the `$filter` property, and we fetch every
      // page and sort locally anyway — so ordering server-side buys nothing.
      params.set('$top', '50');

      const graphMessages: GraphMessage[] = [];
      const visitedUrls = new Set<string>();
      const maxPages = 100;
      let url: string | undefined = `${this.basePath}/messages?${params}`;
      let truncated = false;

      // Page through the whole conversation (follow @odata.nextLink). The
      // maxPages / visitedUrls guards bound a pathological or looping nextLink;
      // on hitting them we stop and return what we have (flagged truncated)
      // rather than throwing away every message already fetched.
      while (url) {
        if (visitedUrls.size >= maxPages || visitedUrls.has(url)) {
          console.warn(
            `[GraphEmailProvider] getThread hit pagination safety limit for conversation ${conversationId}; returning ${graphMessages.length} messages fetched so far`,
          );
          truncated = true;
          break;
        }
        visitedUrls.add(url);

        const response = await this.client.get(url) as GraphMessagePageResponse;
        graphMessages.push(...(response.value ?? []));
        url = response['@odata.nextLink'];
      }

      let messages = graphMessages
        .map(mapGraphMessage)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

      // Guarantee the queried message is present. The conversationId index can
      // lag a just-arrived message (Graph eventual consistency), so if the
      // paged results omit it, splice in the copy we already fetched above so
      // get_thread(id) always anchors on and includes the passed id.
      // receivedDateTime is ISO 8601 here, so localeCompare sorts chronologically.
      if (!messages.some(m => m.id === message.id)) {
        messages = [...messages, message].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      }

      return {
        id: conversationId,
        subject: message.subject,
        messages,
        messageCount: messages.length,
        ...(truncated ? { isTruncated: true } : {}),
      };
    }

    return { id: messageId, subject: message.subject, messages: [message], messageCount: 1 };
  }

  // EmailAttachmentHandler — cheap metadata-only fetch. Used by callers that
  // want metadata without bytes (e.g. `list_attachments`); downloadAttachment
  // does its own single-call fetch and does not preflight through this method.
  async listAttachments(messageId: string): Promise<EmailAttachment[]> {
    const response = await this.client.get(
      `${this.basePath}/messages/${encodeGraphPathId(messageId)}/attachments?$select=${ATTACHMENT_SELECT}`,
    );
    return ((response.value ?? []) as GraphAttachment[]).map(a => ({
      id: a.id,
      filename: a.name ?? '',
      mimeType: a.contentType ?? 'application/octet-stream',
      size: a.size ?? 0,
      isInline: a.isInline ?? false,
      contentId: a.contentId,
    }));
  }

  // Returns bytes + fresh metadata for fileAttachment only. itemAttachment and
  // referenceAttachment lack contentBytes and require the /$value raw-bytes
  // endpoint, which is not yet wired into RealGraphApiClient — those throw
  // AttachmentNotSupportedError so the action layer surfaces NOT_SUPPORTED
  // instead of a generic provider failure. A 404 from Graph maps to
  // AttachmentNotFoundError so race-deleted attachments surface uniformly.
  //   fileAttachment: https://learn.microsoft.com/en-us/graph/api/resources/fileattachment
  //   GET attachment: https://learn.microsoft.com/en-us/graph/api/attachment-get
  async downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
    const select = 'id,name,contentType,size,microsoft.graph.fileAttachment/contentBytes';
    const url = `${this.basePath}/messages/${encodeGraphPathId(messageId)}/attachments/${encodeGraphPathId(attachmentId)}?$select=${select}`;
    let response: GraphAttachment;
    try {
      response = await this.client.get(url) as unknown as GraphAttachment;
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 404) {
        throw new AttachmentNotFoundError(
          `Attachment ${attachmentId} not found on message ${messageId}`,
        );
      }
      throw err;
    }
    if (typeof response.contentBytes !== 'string') {
      const odataType = response['@odata.type'] ?? 'unknown';
      throw new AttachmentNotSupportedError(
        `Attachment ${attachmentId} has @odata.type=${odataType}; only fileAttachment is supported in this version (item/reference attachments require /$value raw-bytes which is not yet implemented)`,
      );
    }
    // Reject obviously malformed base64 before decode. Buffer.from silently
    // strips invalid chars and can return truncated bytes, so guard explicitly.
    // Strip whitespace first — some Graph backends emit MIME-style line-broken
    // base64 in contentBytes, which is still valid; the regex below rejects
    // genuinely garbage payloads like "!!!not_base64$$$".
    const cleanedBytes = response.contentBytes.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*=*$/.test(cleanedBytes)) {
      throw new GraphApiError(
        500,
        `Attachment ${attachmentId} contentBytes contains invalid base64 characters`,
      );
    }
    const content = Buffer.from(cleanedBytes, 'base64');
    // Validate that contentBytes round-trips cleanly: re-encoding the decoded
    // buffer should produce the same canonical base64 length as what Graph
    // sent. This catches truncation in transit and stray invalid chars
    // (Node's decoder silently drops them) without depending on Graph's
    // `size` field — which, for attachments uploaded via the inline
    // fileAttachment path, reflects the stored base64+MIME-framed length
    // and intentionally does NOT match the decoded raw byte count.
    const expectedEncodedLen = Math.ceil(content.length / 3) * 4;
    if (cleanedBytes.length !== expectedEncodedLen) {
      throw new GraphApiError(
        500,
        `Attachment ${attachmentId} contentBytes appears truncated (${cleanedBytes.length} base64 chars, expected ${expectedEncodedLen} for the ${content.length}-byte payload)`,
      );
    }
    return {
      content,
      filename: response.name ?? '',
      mimeType: response.contentType ?? 'application/octet-stream',
      size: response.size ?? content.length,
    };
  }

  // Raw RFC 822 MIME of the message as stored.
  //   https://learn.microsoft.com/en-us/graph/outlook-get-mime-message
  async getRawMessage(messageId: string): Promise<Buffer> {
    if (typeof this.client.getBytes !== 'function') {
      throw new Error('Graph client does not support binary GET');
    }
    try {
      return await this.client.getBytes(`${this.basePath}/messages/${encodeGraphPathId(messageId)}/$value`);
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 404) {
        throw new MessageNotFoundError(`Message ${messageId} not found`);
      }
      throw err;
    }
  }

  async applyLabels(messageId: string, labels: string[]): Promise<void> {
    const existingCategories = await this.getMessageCategories(messageId);
    const categories = [...new Set([...existingCategories, ...labels])];
    await this.client.patch(`${this.basePath}/messages/${encodeGraphPathId(messageId)}`, { categories });
  }

  async removeLabels(messageId: string, labels: string[]): Promise<void> {
    const labelsToRemove = new Set(labels);
    const existingCategories = await this.getMessageCategories(messageId);
    const categories = existingCategories.filter(label => !labelsToRemove.has(label));
    await this.client.patch(`${this.basePath}/messages/${encodeGraphPathId(messageId)}`, { categories });
  }

  async setFlag(messageId: string, flagged: boolean): Promise<void> {
    await this.client.patch(`${this.basePath}/messages/${encodeGraphPathId(messageId)}`, {
      flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
    });
  }

  async setReadState(messageId: string, isRead: boolean): Promise<void> {
    await this.client.patch(`${this.basePath}/messages/${encodeGraphPathId(messageId)}`, { isRead });
  }

  async moveToFolder(messageId: string, folder: string): Promise<string> {
    // Graph POST /move returns the moved message with a NEW id.
    // Resolve against the cache (not forWrite): a move does not alter the folder
    // tree, and a triage loop can move dozens of messages per pass — forcing a
    // fresh traversal per move would trip Graph throttling. The residual risk is
    // the same 60s rename-race we accept for reads: at worst a message lands in
    // a renamed-but-valid folder, which is recoverable, not lost.
    const destinationId = await this.resolveFolderId(folder);
    const result = await this.client.post(`${this.basePath}/messages/${encodeGraphPathId(messageId)}/move`, {
      destinationId,
    });
    return result.id ?? messageId;
  }

  async listFolders(): Promise<EmailFolder[]> {
    const { folders } = await this.getFolderSnapshot();
    return folders.map(folder => ({ ...folder }));
  }

  async createFolder(displayName: string, parentFolder = 'inbox'): Promise<EmailFolder> {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      throw new ProviderError('INVALID_FOLDER_NAME', 'Folder display name cannot be empty', 'microsoft', false);
    }

    const parentId = await this.resolveFolderId(parentFolder, true);
    const parentPath = await this.folderPathFor(parentFolder, parentId);
    const created = await this.client.post(
      `${this.basePath}/mailFolders/${encodeGraphPathId(parentId)}/childFolders`,
      { displayName: trimmedName },
    ) as unknown as GraphMailFolder;

    this.invalidateFolderCaches();
    return mapGraphFolder(created, parentPath ? `${parentPath}/${trimmedName}` : trimmedName);
  }

  async deleteFolder(folder: string): Promise<void> {
    const normalizedInput = normalizeFolderLookup(folder);
    if (SYSTEM_FOLDER_NAME_SET.has(normalizedInput)) {
      throw systemFolderProtectedError(folder);
    }

    const folderId = await this.resolveFolderId(folder, true);
    const systemFolderIds = await this.getSystemFolderIds();
    if (systemFolderIds.has(folderId)) {
      throw systemFolderProtectedError(folder);
    }

    await this.client.delete(`${this.basePath}/mailFolders/${encodeGraphPathId(folderId)}`);
    this.invalidateFolderCaches();
  }

  async listInboxRules(): Promise<InboxRule[]> {
    const rules: InboxRule[] = [];
    const visitedUrls = new Set<string>();
    let url: string | undefined = `${this.basePath}/mailFolders/inbox/messageRules`;

    while (url) {
      if (visitedUrls.has(url) || visitedUrls.size >= 100) {
        throw new ProviderError('PAGINATION_LIMIT', 'Inbox rule pagination exceeded its safety limit', 'microsoft', false);
      }
      visitedUrls.add(url);
      const response = await this.client.get(url) as GraphRulePageResponse;
      rules.push(...(response.value ?? []));
      url = response['@odata.nextLink'];
    }

    return rules;
  }

  async createInboxRule(rule: CreateInboxRule): Promise<InboxRule> {
    // Defense in depth: the create_inbox_rule action already enforces an
    // allowlist, but this method is part of the public EmailRuleManager
    // interface and must be safe when called directly. Graph treats JSON keys
    // case-insensitively, so a case-sensitive blocklist alone would let
    // `ForwardTo` through — match on the normalized key and allowlist rather
    // than blocklist, so unknown future Graph actions fail closed.
    // Rebuild the actions object with canonical camelCase keys. Graph accepts
    // keys case-insensitively, so a caller passing `MoveToFolder` would pass
    // the normalized allowlist check yet slip past a case-sensitive
    // `actions['moveToFolder']` destructive-destination check below. Normalizing
    // keys up front closes that bypass and guarantees the payload we POST uses
    // exactly the safe keys we validated.
    const actions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rule.actions)) {
      const normalized = key.trim().toLowerCase();
      if (BLOCKED_RULE_ACTIONS.has(normalized)) {
        throw new ProviderError(
          'UNSAFE_RULE_ACTION',
          `Inbox rule action '${key}' is blocked for security`,
          'microsoft',
          false,
        );
      }
      const canonical = CANONICAL_RULE_ACTIONS[normalized];
      if (!canonical) {
        throw new ProviderError(
          'UNSUPPORTED_RULE_ACTION',
          `Inbox rule action '${key}' is not supported for creation`,
          'microsoft',
          false,
        );
      }
      // Validate value shapes locally instead of forwarding wrong-typed values
      // to Graph. A non-string moveToFolder would otherwise skip the
      // destructive-destination inspection entirely (it only fires on strings).
      if (!isValidRuleActionValue(canonical, value)) {
        throw new ProviderError(
          'INVALID_RULE_ACTION_VALUE',
          `Inbox rule action '${key}' has an invalid value for its type`,
          'microsoft',
          false,
        );
      }
      actions[canonical] = value;
    }

    // Resolve folder destinations to opaque ids and reject mail-discarding ones.
    // resolveRuleDestinationId does the destructive check on the canonical
    // resolved folder, closing alias/slash/case bypasses like `/trash/`.
    // Start both validations together so move/copy share a fresh traversal.
    await Promise.all((['moveToFolder', 'copyToFolder'] as const).map(async folderAction => {
      const destination = actions[folderAction];
      if (typeof destination === 'string') {
        actions[folderAction] = await this.resolveRuleDestinationId(destination);
      }
    }));

    // Graph rejects sequence 0 (`MessageRuleValidationError` on Field 'Sequence'),
    // which is exactly the value it assigns when a POST omits sequence. The tool
    // exists so an agent can propose a rule without knowing Exchange internals,
    // so when the caller doesn't specify one, append the rule after the existing
    // rules (max existing sequence + 1, or 1 for an empty mailbox).
    const GRAPH_MAX_SEQUENCE = 2_147_483_647; // Graph stores sequence as Int32.
    let sequence = rule.sequence;
    if (sequence === undefined || sequence === null) {
      const existing = await this.listInboxRules();
      const maxExisting = existing.reduce((max, r) => Math.max(max, r.sequence ?? 0), 0);
      // Defensive: never exceed Int32 (a pathological existing sequence at the
      // ceiling would otherwise overflow to an invalid value).
      sequence = Math.min(maxExisting + 1, GRAPH_MAX_SEQUENCE);
    } else if (!Number.isInteger(sequence) || sequence < 1 || sequence > GRAPH_MAX_SEQUENCE) {
      // The action schema already enforces this, but the provider is a public
      // interface — reject an out-of-range explicit sequence rather than letting
      // Graph fail it with an opaque 400.
      throw new ProviderError(
        'INVALID_RULE_SEQUENCE',
        `Inbox rule sequence must be an integer between 1 and ${GRAPH_MAX_SEQUENCE}; received ${sequence}`,
        'microsoft',
        false,
      );
    }

    // Spread `actions` last so the canonicalized/resolved actions replace the
    // caller's original (possibly mis-cased) actions in the payload.
    return await this.client.post(`${this.basePath}/mailFolders/inbox/messageRules`, {
      ...rule,
      sequence,
      actions,
    }) as InboxRule;
  }

  async deleteInboxRule(id: string): Promise<void> {
    await this.client.delete(
      `${this.basePath}/mailFolders/inbox/messageRules/${encodeGraphPathId(id)}`,
    );
  }

  async deleteMessage(messageId: string, hard = false): Promise<void> {
    if (hard) {
      await this.client.post(`${this.basePath}/messages/${encodeGraphPathId(messageId)}/permanentDelete`);
      return;
    }

    await this.moveToFolder(messageId, 'deleteditems');
  }

  async sendMessage(msg: ComposeMessage): Promise<SendResult> {
    const sizeError = checkGraphAttachmentLimits(msg.attachments);
    if (sizeError) {
      return { success: false, error: sizeError };
    }

    const trackingId = msg.trackingId ?? `ae-${Date.now()}`;
    const graphMsg: Record<string, unknown> = {
      subject: msg.subject.slice(0, SUBJECT_MAX_LENGTH),
      body: buildGraphBody(msg.bodyHtml, msg.body),
      toRecipients: toGraphRecipients(msg.to),
      ccRecipients: toGraphRecipients(msg.cc),
      bccRecipients: toGraphRecipients(msg.bcc),
      singleValueExtendedProperties: [
        { id: TRACKING_PROPERTY, value: trackingId },
      ],
    };
    const draftUpload = needsGraphDraftUpload(msg.attachments);
    if (!draftUpload && msg.attachments && msg.attachments.length > 0) {
      graphMsg.attachments = msg.attachments.map(toGraphFileAttachment);
    }

    if (draftUpload) {
      let draftId: string | undefined;
      try {
        const draft = await this.client.post(`${this.basePath}/messages`, graphMsg);
        if (!draft.id) throw new Error('Microsoft Graph created no draft id');
        draftId = draft.id;
        await this.postDraftAttachments(draftId, msg.attachments!);
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'ATTACHMENT_UPLOAD_FAILED',
            message: `${draftId ? `Draft ${draftId} was created, but ` : ''}Microsoft Graph could not upload the attachments: ${err instanceof Error ? err.message : String(err)}`,
            provider: 'microsoft',
            recoverable: false,
          },
        };
      }
      try {
        await this.client.post(`${this.basePath}/messages/${encodeGraphPathId(draftId!)}/send`, {});
        return { success: true, messageId: trackingId };
      } catch (err) {
        return {
          success: false,
          error: graphDeliveryError(err, {
            ambiguous: `Microsoft Graph may have accepted this message for delivery. Do not resend automatically; check Sent Items for tracking id ${trackingId} first.`,
            terminal: `Microsoft Graph rejected this message; it was not delivered and draft ${draftId} remains available.`,
          }),
        };
      }
    }

    // Only the dispatch itself is wrapped. Everything above is local payload
    // construction — if that throws, nothing was submitted, so it must not be
    // reported as a possible delivery.
    try {
      await this.client.post(`${this.basePath}/sendMail`, { message: graphMsg });
    } catch (err) {
      return {
        success: false,
        error: graphDeliveryError(err, {
          ambiguous: `Microsoft Graph may have accepted this message for delivery. Do not resend automatically; check Sent Items for tracking id ${trackingId} first.`,
          terminal: 'Microsoft Graph rejected this message; it was not delivered.',
        }),
      };
    }
    // sendMail returns 202 with no body — use tracking ID for sent message lookup
    return { success: true, messageId: trackingId };
  }

  async replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult> {
    // Routes to createReply or createReplyAll based on opts.replyAll. Both Graph
    // endpoints preserve embedded images, CID references, and the auto-quoted thread.
    // Split deliberately. Preparing the draft is pre-dispatch: nothing has been
    // submitted for delivery, so any failure there is terminal and must NOT be
    // reported as ambiguous. Only the /send POST can leave delivery in doubt.
    let draftId: string;
    try {
      draftId = await this.prepareReplyDraft(messageId, body, opts);
    } catch (err) {
      if (err instanceof GraphAttachmentError) {
        const detail = err.draftId
          ? ` A reply draft (${err.draftId}) was created but not sent.`
          : '';
        return {
          success: false,
          messageId: err.draftId,
          error: { ...err.emailError,
            code: err.emailError.code === 'DRAFT_PREPARATION_FAILED' ? 'REPLY_FAILED' : err.emailError.code,
            message: err.emailError.message + detail },
        };
      }
      const message = err instanceof Error ? err.message : 'Failed to prepare reply';
      return { success: false, error: { code: 'REPLY_FAILED', message, recoverable: false } };
    }

    try {
      await this.client.post(`${this.basePath}/messages/${encodeGraphPathId(draftId)}/send`, {});
    } catch (err) {
      return {
        success: false,
        error: graphDeliveryError(err, {
          ambiguous: `Microsoft Graph may have accepted this reply for delivery. Do not resend automatically; inspect message ${draftId} — it is in Sent Items if it was delivered, Drafts if it was not.`,
          terminal: `Microsoft Graph rejected this reply; it was not delivered. The prepared draft remains at ${draftId}.`,
        }),
      };
    }
    return { success: true, messageId: draftId };
  }

  async createDraft(msg: ComposeMessage): Promise<DraftResult> {
    const sizeError = checkGraphAttachmentLimits(msg.attachments);
    if (sizeError) {
      return { success: false, error: sizeError };
    }

    const graphMsg: Record<string, unknown> = {
      subject: msg.subject,
      body: buildGraphBody(msg.bodyHtml, msg.body),
      toRecipients: toGraphRecipients(msg.to),
      ccRecipients: toGraphRecipients(msg.cc),
      bccRecipients: toGraphRecipients(msg.bcc),
      singleValueExtendedProperties: [
        { id: DRAFT_ORIGIN_PROPERTY, value: 'non_reply' },
      ],
    };
    const draftUpload = needsGraphDraftUpload(msg.attachments);
    if (!draftUpload && msg.attachments && msg.attachments.length > 0) {
      graphMsg.attachments = msg.attachments.map(toGraphFileAttachment);
    }

    const response = await this.client.post(`${this.basePath}/messages`, graphMsg);
    if (draftUpload) {
      if (!response.id) {
        return { success: false, error: { code: 'DRAFT_FAILED', message: 'Microsoft Graph created no draft id', recoverable: false } };
      }
      try {
        await this.postDraftAttachments(response.id, msg.attachments!);
      } catch (err) {
        return {
          success: false,
          draftId: response.id,
          error: {
            code: 'ATTACHMENT_UPLOAD_FAILED',
            message: `Draft ${response.id} was created but attaching files failed: ${err instanceof Error ? err.message : String(err)}`,
            recoverable: false,
          },
        };
      }
    }
    return { success: true, draftId: response.id };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    try {
      await this.client.post(`${this.basePath}/messages/${encodeGraphPathId(draftId)}/send`, {});
    } catch (err) {
      return {
        success: false,
        error: graphDeliveryError(err, {
          ambiguous: `Microsoft Graph may have accepted draft ${draftId} for delivery. Do not resend automatically; the draft is gone from Drafts and present in Sent Items if it was delivered.`,
          terminal: `Microsoft Graph rejected draft ${draftId}; it was not delivered and remains in Drafts.`,
        }),
      };
    }
    return { success: true, messageId: draftId };
  }

  async scheduleMessage(msg: ComposeMessage, scheduledSendAt: string): Promise<ScheduledSendResult> {
    const sizeError = checkGraphAttachmentLimits(msg.attachments);
    if (sizeError) return {
      success: false, error: sizeError,
      workflow: { phase: 'terminal', outcome: 'rejected', lastPhase: 'preparing' },
    };

    const trackingId = msg.trackingId ?? `ae-${Date.now()}`;
    const graphMsg: Record<string, unknown> = {
      subject: msg.subject.slice(0, SUBJECT_MAX_LENGTH),
      body: buildGraphBody(msg.bodyHtml, msg.body),
      toRecipients: toGraphRecipients(msg.to),
      ccRecipients: toGraphRecipients(msg.cc),
      bccRecipients: toGraphRecipients(msg.bcc),
      singleValueExtendedProperties: [
        { id: TRACKING_PROPERTY, value: trackingId },
        { id: DRAFT_ORIGIN_PROPERTY, value: 'non_reply' },
      ],
    };
    const draftUpload = needsGraphDraftUpload(msg.attachments);
    if (!draftUpload && msg.attachments && msg.attachments.length > 0) {
      graphMsg.attachments = msg.attachments.map(toGraphFileAttachment);
    }

    return this.runSchedule(scheduledSendAt, undefined, async () => {
      const created = await this.client.post(`${this.basePath}/messages`, graphMsg);
      if (!created.id) throw new Error('Microsoft Graph created no scheduled-send draft id');
      return created.id;
    }, async id => {
      if (draftUpload) await this.postDraftAttachments(id, msg.attachments!);
    });
  }

  async scheduleDraft(draftId: string, scheduledSendAt: string): Promise<ScheduledSendResult> {
    return this.runSchedule(scheduledSendAt, draftId);
  }

  private async runSchedule(
    scheduledSendAt: string,
    draftId?: string,
    createDraft: () => Promise<string> = async () => { throw new Error('Missing draft'); },
    prepareAttachments: (id: string) => Promise<void> = async () => {},
  ): Promise<ScheduledSendResult> {
    // Attachments are complete before applying the marker. A failed PATCH may
    // still have applied remotely; retain the handle without cleanup or replay.
    return runScheduledWorkflow({
      scheduledSendAt, draftId, createDraft, prepareAttachments,
      setDeferredProperty: async id => {
        await this.client.patch(`${this.basePath}/messages/${encodeGraphPathId(id)}`, {
          singleValueExtendedProperties: [
            { id: DEFERRED_SEND_PROPERTY, value: scheduledSendAt },
          ],
        });
      },
      dispatch: async id => {
        await this.client.post(`${this.basePath}/messages/${encodeGraphPathId(id)}/send`, {});
      },
      preparationError: (err, phase) => ({
        code: phase === 'draft_created' ? 'ATTACHMENT_UPLOAD_FAILED' : 'SCHEDULE_DRAFT_FAILED',
        message: `Scheduled-send preparation failed at ${phase}; no dispatch attempted. Any retained draft may include partial changes. Inspect it before further action. ${err instanceof Error ? err.message : String(err)}`,
        provider: 'microsoft', recoverable: false,
      }),
      dispatchError: (err, id) => scheduledDispatchFailure(id, err),
    });
  }

  /**
   * Discovery is mailbox-wide, not Drafts-scoped: Outlook's own "Schedule send"
   * leaves the deferred message wherever it likes — observed live in Deleted
   * Items — so folder membership says nothing about whether a send is pending.
   * Graph cannot filter on the proptag-style deferred property server-side
   * (`singleValueExtendedProperties/any(...)` on `SystemTime 0x3FEF` is rejected
   * with ErrorInvalidUrlQueryFilter, for eq and ge alike), so the narrowing that
   * keeps the scan bounded is `isDraft eq true` and the deferred property is
   * matched client-side. A pending deferred send is always still a draft, and
   * without that filter this would page the entire mailbox.
   */
  async listScheduledSends(): Promise<ScheduledSend[]> {
    const propertyFilter = `$filter=id eq '${DEFERRED_SEND_PROPERTY}'`;
    let url: string | undefined = `${this.basePath}/messages`
      + `?$select=id,subject,toRecipients,isDraft&$filter=isDraft eq true`
      + `&$top=${SCHEDULED_SEND_PAGE_SIZE}`
      + `&$expand=singleValueExtendedProperties(${propertyFilter})`;
    const messages: GraphMessage[] = [];
    const visitedUrls = new Set<string>();
    while (url) {
      if (visitedUrls.has(url) || visitedUrls.size >= 100) {
        throw new ProviderError(
          'PAGINATION_LIMIT',
          'Scheduled-send pagination exceeded its safety limit',
          'microsoft',
          false,
        );
      }
      visitedUrls.add(url);
      const response = await this.client.get(url) as GraphMessagePageResponse;
      messages.push(...(response.value ?? []));
      url = response['@odata.nextLink'];
    }

    const scheduled: ScheduledSend[] = [];
    const now = Date.now();
    for (const message of messages) {
      const property = findDeferredSendProperty(message);
      if (message.isDraft !== true || !property) continue;
      const validated = validateScheduledSendAt(property.value, now);
      if ('error' in validated) continue;
      const timestamp = Date.parse(validated.value);
      // Outlook leaves the tagged copy behind after delivery, so a past
      // deferred time marks residue rather than a pending send. Drafts-scoped
      // discovery rarely saw those; a mailbox-wide scan sees all of them.
      if (timestamp <= now) continue;
      scheduled.push({
        messageId: message.id,
        subject: message.subject ?? '',
        to: (message.toRecipients ?? []).map(recipient => ({
          email: recipient.emailAddress.address,
          name: recipient.emailAddress.name,
        })),
        scheduledSendAt: new Date(timestamp).toISOString(),
      });
    }
    return scheduled;
  }

  async cancelScheduledSend(messageId: string): Promise<void> {
    const encodedId = encodeGraphPathId(messageId);
    const propertyFilter = `$filter=id eq '${DEFERRED_SEND_PROPERTY}'`;
    let candidate: GraphMessage;
    try {
      candidate = await this.client.get(
        `${this.basePath}/messages/${encodedId}`
        + `?$select=id,isDraft&$expand=singleValueExtendedProperties(${propertyFilter})`,
      ) as unknown as GraphMessage;
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 404) {
        throw scheduledSendNotFoundError();
      }
      throw err;
    }
    const marker = findDeferredSendProperty(candidate)?.value;
    if (candidate.isDraft !== true || marker === undefined || 'error' in validateScheduledSendAt(marker)) {
      throw scheduledSendNotFoundError();
    }
    try {
      // Graph offers no verified conditional DELETE for this flow. Delivery
      // can win after the observation; deletion cannot recall delivered mail.
      await this.client.delete(`${this.basePath}/messages/${encodedId}`);
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 404) {
        throw scheduledSendNotFoundError();
      }
      throw err;
    }
  }

  async createReplyDraft(messageId: string, body: string, opts?: ReplyOptions): Promise<DraftResult> {
    // Routes to createReply or createReplyAll based on opts.replyAll. Both Graph
    // endpoints preserve embedded images, CID references, and the auto-quoted thread.
    try {
      const draftId = await this.prepareReplyDraft(messageId, body, opts);
      return { success: true, draftId };
    } catch (err) {
      if (err instanceof GraphAttachmentError) {
        return { success: false, draftId: err.draftId, error: err.emailError };
      }
      const message = err instanceof Error ? err.message : 'Failed to create reply draft';
      return { success: false, error: { code: 'DRAFT_FAILED', message, recoverable: false } };
    }
  }

  /**
   * Shared helper for both reply paths. Calls createReply (sender only) when
   * opts.replyAll is explicitly false, otherwise createReplyAll (sender + thread
   * recipients). Then merges Graph's auto-quoted body with the caller's content
   * and merges Graph's auto-populated recipients with caller-supplied additions
   * before PATCHing the draft.
   *
   * Returns the draft id. Throws if the Graph endpoint fails or returns no id.
   */
  /**
   * POST each attachment to a draft's `/attachments` collection. Used for the
   * two-step draft attachment flow (reply drafts, draft updates), since Graph's
   * createReply/createReplyAll and PATCH paths cannot carry attachments inline.
   */
  private async postDraftAttachments(draftId: string, attachments: OutboundAttachment[]): Promise<void> {
    for (const att of attachments) {
      if (att.content.length <= GRAPH_INLINE_ATTACHMENT_LIMIT) {
        await this.client.post(
          `${this.basePath}/messages/${encodeGraphPathId(draftId)}/attachments`,
          toGraphFileAttachment(att),
        );
        continue;
      }
      if (!this.client.putUploadChunk) {
        throw new Error('Graph client does not support large-attachment upload sessions');
      }
      const session = await this.client.post(
        `${this.basePath}/messages/${encodeGraphPathId(draftId)}/attachments/createUploadSession`,
        {
          AttachmentItem: {
            attachmentType: 'file',
            name: att.filename,
            size: att.content.length,
            contentType: att.mimeType,
          },
        },
      );
      const uploadUrl = session.uploadUrl;
      if (typeof uploadUrl !== 'string' || uploadUrl.length === 0) {
        throw new Error(`Microsoft Graph returned no upload URL for "${att.filename}"`);
      }
      for (let start = 0; start < att.content.length; start += GRAPH_UPLOAD_CHUNK_SIZE) {
        const chunk = att.content.subarray(start, Math.min(start + GRAPH_UPLOAD_CHUNK_SIZE, att.content.length));
        await this.client.putUploadChunk(uploadUrl, chunk, start, att.content.length);
      }
    }
  }

  private async prepareReplyDraft(
    messageId: string,
    body: string,
    opts?: ReplyOptions,
  ): Promise<string> {
    // Size preflight before creating the draft, so an oversize attachment
    // never leaves an orphan draft behind.
    const sizeError = checkGraphAttachmentLimits(opts?.attachments);
    if (sizeError) {
      throw new GraphAttachmentError(sizeError);
    }

    const endpoint = opts?.replyAll === false ? 'createReply' : 'createReplyAll';
    const draft = await this.client.post(
      `${this.basePath}/messages/${encodeGraphPathId(messageId)}/${endpoint}`,
      {},
    );
    if (!draft.id) throw new Error(`${endpoint} did not return a draft id`);

    try {
      let draftBody = draft.body as { contentType?: string; content?: string } | undefined;
      let draftTo = (draft.toRecipients as GraphRecipient[] | undefined) ?? [];
      let draftCc = (draft.ccRecipients as GraphRecipient[] | undefined) ?? [];
      let draftBcc = (draft.bccRecipients as GraphRecipient[] | undefined) ?? [];

      // Fallback GET when the POST response lacks a usable HTML body. Graph defaults
      // to HTML on `Get message` so no Prefer header is needed.
      if (typeof draftBody?.content !== 'string' || draftBody.contentType?.toLowerCase() !== 'html') {
        const fetched = await this.client.get(`${this.basePath}/messages/${encodeGraphPathId(draft.id)}`);
        draftBody = fetched.body as { contentType?: string; content?: string } | undefined;
        draftTo = (fetched.toRecipients as GraphRecipient[] | undefined) ?? [];
        draftCc = (fetched.ccRecipients as GraphRecipient[] | undefined) ?? [];
        draftBcc = (fetched.bccRecipients as GraphRecipient[] | undefined) ?? [];
      }

      const draftContent = typeof draftBody?.content === 'string' ? draftBody.content : '';
      const callerFragment = opts?.bodyHtml !== undefined
        ? stripHtmlBodyWrappers(opts.bodyHtml)
        : wrapPlainTextAsHtml(body);
      const merged = mergeQuotedReplyHtml(draftContent, callerFragment);

      const patch: Record<string, unknown> = {
        body: { contentType: 'HTML', content: truncateBody(merged) },
        singleValueExtendedProperties: [
          { id: DRAFT_ORIGIN_PROPERTY, value: 'reply' },
        ],
      };

      // `to` REPLACES Graph's auto-populated recipients; `cc`/`bcc` below MERGE
      // with the thread's. The asymmetry is deliberate (issue #164): merging a
      // caller-supplied To would leave the parent's sender on the To line, which
      // is exactly the failure being fixed — a reply to your own sent message
      // stays addressed to yourself. Absent `to`, the patch omits toRecipients
      // entirely and Graph's derived To stands, unchanged from before.
      // mergeRecipients([], …) is reused only for its EmailAddress →
      // GraphRecipient conversion and case-insensitive dedupe.
      const hasExplicitTo = Boolean(opts?.to && opts.to.length > 0);

      // Anyone on `bcc` comes off the visible lines Graph derived, so a thread
      // participant can be moved to Bcc without restating the audience (issue
      // #214). Bcc wins over a derived To/Cc.
      const hidden = new Set((opts?.bcc ?? []).map(a => a.email.toLowerCase()));
      const isVisible = (r: GraphRecipient): boolean =>
        !hidden.has(r.emailAddress?.address?.toLowerCase() ?? '');

      if (hasExplicitTo) {
        patch.toRecipients = mergeRecipients([], opts!.to!).filter(isVisible);
      } else if (draftTo.some(r => !isVisible(r))) {
        // Only touch toRecipients when something must come off it; otherwise
        // Graph's derived To stands untouched, as before.
        patch.toRecipients = draftTo.filter(isVisible);
      }

      // Replacing the To line must not silently drop anyone. On the reply-all
      // endpoint Graph puts the parent's sender AND its other To participants on
      // the draft's To; an explicit `to` displaces all of them, so demote the
      // displaced ones to Cc — reply-all means the thread stays on the message,
      // and `to` only decides who it is addressed to. This also brings Microsoft
      // in line with Gmail, which already carries the thread's participants on Cc
      // under reply-all. On the sender-only endpoint there is nothing to preserve:
      // Graph's To is just the parent's sender, and replacing that is the point of
      // a narrowed redirect.
      const displacedTo = hasExplicitTo && opts?.replyAll !== false
        ? draftTo.filter(r => {
          const address = r.emailAddress?.address?.toLowerCase();
          return address ? !opts!.to!.some(a => a.email.toLowerCase() === address) : false;
        })
        : [];

      const ccMerged = mergeRecipients([...draftCc, ...displacedTo], opts?.cc ?? []).filter(isVisible);
      if (ccMerged.length > 0 || draftCc.some(r => !isVisible(r))) patch.ccRecipients = ccMerged;

      const bccMerged = mergeRecipients(draftBcc, opts?.bcc ?? []);
      if (bccMerged.length > 0) patch.bccRecipients = bccMerged;

      await this.client.patch(`${this.basePath}/messages/${encodeGraphPathId(draft.id)}`, patch);

      // Two-step attachment upload: the draft now exists, so POST each file to
      // its /attachments collection. A failure here leaves a created-but-
      // incomplete draft — surface its id so the caller can inspect or retry.
      if (opts?.attachments && opts.attachments.length > 0) {
        try {
          await this.postDraftAttachments(draft.id, opts.attachments);
        } catch (err) {
          throw new GraphAttachmentError(
            {
              code: 'ATTACHMENT_UPLOAD_FAILED',
              message: `Reply draft was created but attaching files failed: ${err instanceof Error ? err.message : String(err)}`,
              recoverable: false,
            },
            draft.id,
          );
        }
      }

      return draft.id;
    } catch (err) {
      if (err instanceof GraphAttachmentError) throw err;
      throw new GraphAttachmentError({
        code: 'DRAFT_PREPARATION_FAILED',
        message: `Reply draft was created but preparation failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      }, draft.id);
    }
  }

  async getDraft(draftId: string): Promise<EmailMessage> {
    // Preserve the existing expanded attachment/unique-body preview reader.
    const message = await this.getMessage(draftId);
    if (message.isDraft !== true) throw new MessageNotFoundError(`Editable draft ${draftId} not found`);
    return message;
  }

  async getDraftSnapshot(draftId: string): Promise<DraftSnapshot> {
    let metadata: GraphMessage;
    try {
      metadata = await this.client.get(
        `${this.basePath}/messages/${encodeGraphPathId(draftId)}`
        + `?$select=${MESSAGE_SELECT},conversationIndex,changeKey`
        + `&$expand=singleValueExtendedProperties($filter=id eq '${DRAFT_ORIGIN_PROPERTY}' or id eq '${DEFERRED_SEND_PROPERTY}')`,
      ) as unknown as GraphMessage;
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 404) throw new MessageNotFoundError(`Draft ${draftId} not found`);
      throw err;
    }
    const scheduledSendAt = findDeferredSendProperty(metadata)?.value;
    const pending = scheduledSendAt !== undefined && !('error' in validateScheduledSendAt(scheduledSendAt));
    return {
      draftId: metadata.id,
      messageId: metadata.id,
      message: mapGraphMessage(metadata),
      revision: metadata.changeKey,
      lifecycle: metadata.isDraft === true ? (pending ? 'deferred' : 'editable') : 'indeterminate',
      origin: this.draftOrigin(metadata),
      scheduledSendAt,
    };
  }

  async getDraftReplyStatus(draftId: string): Promise<DraftReplyStatus> {
    const propertyFilter = `$filter=id eq '${DRAFT_ORIGIN_PROPERTY}'`;
    let metadata: GraphMessage;
    try {
      metadata = await this.client.get(
        `${this.basePath}/messages/${encodeGraphPathId(draftId)}`
        + `?$select=isDraft,conversationIndex`
        + `&$expand=singleValueExtendedProperties(${propertyFilter})`,
      ) as unknown as GraphMessage;
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 404) {
        throw new MessageNotFoundError(`Draft ${draftId} not found`);
      }
      throw err;
    }

    return metadata.isDraft === true ? this.draftOrigin(metadata) : 'indeterminate';
  }

  private draftOrigin(metadata: GraphMessage): DraftReplyStatus {
    // Duplicate stamps are ambiguous: taking the first match would make the
    // answer depend on the order Graph returns the collection. Only a single,
    // unanimous stamp is authoritative.
    const originStamps = (metadata.singleValueExtendedProperties ?? []).filter(
      property => property.id.toLowerCase() === DRAFT_ORIGIN_PROPERTY.toLowerCase(),
    );
    if (originStamps.length > 0) {
      const values = originStamps.map(property => property.value);
      const unanimous = values.every(value => value === values[0]);
      if (!unanimous) return 'indeterminate';
      if (values[0] === 'reply') return 'reply';
      if (values[0] === 'non_reply') return 'non_reply';
      return 'indeterminate';
    }

    const conversationIndexBytes = decodeConversationIndex(metadata.conversationIndex);
    if (conversationIndexBytes === undefined) return 'indeterminate';
    return conversationIndexBytes > 22 ? 'reply' : 'indeterminate';
  }

  async updateDraft(draftId: string, msg: Partial<ComposeMessage>): Promise<DraftResult> {
    const patch: Record<string, unknown> = {};
    if (msg.body !== undefined || msg.bodyHtml !== undefined) {
      // update_draft admits body writes only for provider-confirmed non-reply
      // drafts with explicit caller opt-in. Graph PATCH replaces that body
      // wholesale; no quoted-history boundary inspection belongs here.
      patch.body = buildGraphBody(msg.bodyHtml, msg.body ?? '');
    }
    if (msg.subject !== undefined) patch.subject = msg.subject.slice(0, SUBJECT_MAX_LENGTH);
    // An omitted list leaves the draft's existing recipients untouched (Graph
    // PATCH is a merge); a provided list replaces them.
    if (msg.to) patch.toRecipients = toGraphRecipients(msg.to);
    if (msg.cc) patch.ccRecipients = toGraphRecipients(msg.cc);
    if (msg.bcc) patch.bccRecipients = toGraphRecipients(msg.bcc);

    // Attachments: an omitted field preserves the draft's existing attachments
    // (Graph attachments are child resources untouched by this PATCH). A
    // provided array replaces them — delete the existing set, then add the new
    // one. Size preflight runs first so nothing is deleted if it would fail.
    if (msg.attachments !== undefined) {
      const sizeError = checkGraphAttachmentLimits(msg.attachments);
      if (sizeError) {
        return { success: false, draftId, error: sizeError };
      }
    }

    try {
      await this.client.patch(`${this.basePath}/messages/${encodeGraphPathId(draftId)}`, patch);
    } catch (err) {
      return { success: false, draftId, error: {
        code: 'UPDATE_DRAFT_FAILED',
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      } };
    }

    if (msg.attachments !== undefined) {
      try {
        const existing = await this.client.get(
          `${this.basePath}/messages/${encodeGraphPathId(draftId)}/attachments?$select=id`,
        );
        for (const att of ((existing.value ?? []) as Array<{ id?: string }>)) {
          if (att.id) {
            await this.client.delete(
              `${this.basePath}/messages/${encodeGraphPathId(draftId)}/attachments/${encodeGraphPathId(att.id)}`,
            );
          }
        }
        await this.postDraftAttachments(draftId, msg.attachments);
      } catch (err) {
        return {
          success: false,
          draftId,
          error: {
            code: 'ATTACHMENT_UPDATE_FAILED',
            message: `Draft ${draftId} field updates were applied, but replacing attachments failed: ${err instanceof Error ? err.message : String(err)}`,
            recoverable: false,
          },
        };
      }
    }

    return { success: true, draftId };
  }

  /**
   * Retrieve a complete inclusive timestamp window; partial results never escape.
   * The optional end preserves existing callers while bounding every invocation.
   * This is the primary method for the watcher polling loop.
   */
  async getNewMessages(since: string, end = new Date().toISOString(), signal?: AbortSignal): Promise<EmailMessage[]> {
    if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(end)) || Date.parse(since) > Date.parse(end)) {
      throw new Error('Invalid watcher timestamp window');
    }
    const filter = `receivedDateTime ge ${since} and receivedDateTime le ${end}`;
    const params = `$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime desc&$top=50&${DELTA_SELECT}`;
    let url: string | undefined = `${this.basePath}/mailFolders/Inbox/messages?${params}`;
    const seen = new Set<string>();
    const messages: EmailMessage[] = [];
    while (url) {
      signal?.throwIfAborted();
      if (seen.has(url) || seen.size >= 1000) throw new Error('Watcher pagination repeated a link or exceeded 1000 pages');
      seen.add(url);
      const response = await this.client.get(url, signal);
      signal?.throwIfAborted();
      if (!Array.isArray(response.value)) throw new Error('Invalid watcher message page');
      for (const raw of response.value) {
        // The general mapper supplies defaults for other actions. Watcher
        // windows must validate source identity/time before those defaults.
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('Invalid watcher message identity or timestamp');
        }
        const message = raw as Record<string, unknown>;
        if (typeof message.id !== 'string' || !message.id.trim()
          || !Object.hasOwn(message, 'receivedDateTime')
          || typeof message.receivedDateTime !== 'string' || !message.receivedDateTime.trim()
          || !Number.isFinite(Date.parse(message.receivedDateTime))) {
          throw new Error('Invalid watcher message identity or timestamp');
        }
        messages.push(mapGraphMessage(raw as GraphMessage));
      }
      const next = response['@odata.nextLink'];
      if (next !== undefined && (typeof next !== 'string' || !next)) throw new Error('Invalid watcher nextLink');
      url = next as string | undefined;
    }
    return messages.filter(message => {
      const received = Date.parse(message.receivedAt);
      if (!Number.isFinite(received)) throw new Error('Invalid watcher message timestamp');
      return received >= Date.parse(since) && received <= Date.parse(end);
    });
  }

  /**
   * Delta Query polling — follows all pages.
   * Note: Delta Query requires paging through the ENTIRE inbox on first use,
   * even with $deltatoken=latest. Use getNewMessages() for the watcher instead.
   * This method is kept for scenarios that need full sync (e.g., offline sync).
   */
  async getDeltaMessages(deltaLink: string): Promise<DeltaResult> {
    let url = deltaLink;

    const allMessages: EmailMessage[] = [];
    let finalDeltaLink = '';
    const visited = new Set<string>();

    // Page through all results (follow @odata.nextLink until @odata.deltaLink)
    while (url) {
      if (visited.has(url) || visited.size >= 100) {
        throw new ProviderError('PAGINATION_LIMIT', 'Delta pagination exceeded its safety limit', 'microsoft', false);
      }
      visited.add(url);
      const response = await this.client.get(url) as DeltaPageResponse;
      const items = response.value ?? [];

      // Filter out @removed tombstones and map the rest
      for (const item of items) {
        if (item['@removed']) continue; // Deleted/moved message — skip
        allMessages.push(mapGraphMessage(item as GraphMessage));
      }

      if (response['@odata.deltaLink']) {
        // We have the final deltaLink — done paging
        finalDeltaLink = response['@odata.deltaLink'];
        break;
      } else if (response['@odata.nextLink']) {
        // More pages to fetch
        url = response['@odata.nextLink'];
      } else {
        throw new ProviderError('INVALID_DELTA_RESPONSE', 'Delta response omitted the terminal cursor', 'microsoft', false);
      }
    }

    return {
      messages: allMessages,
      nextDeltaLink: finalDeltaLink,
    };
  }

  // NemoClaw egress domains
  static get egressDomains(): string[] {
    return ['graph.microsoft.com', 'login.microsoftonline.com'];
  }

  private async getMessageCategories(messageId: string): Promise<string[]> {
    const response = await this.client.get(
      `${this.basePath}/messages/${encodeGraphPathId(messageId)}?$select=categories`,
    ) as { categories?: unknown };

    return Array.isArray(response.categories)
      ? response.categories.filter((value): value is string => typeof value === 'string')
      : [];
  }

  private async getFolderSnapshot(fresh = false): Promise<FolderSnapshot> {
    return this.folderCache.get(async () => {
      const budget = { remaining: MAX_FOLDER_REQUESTS_PER_SNAPSHOT, truncated: false };
      const folders = await this.fetchFolderCollection(
        `${this.basePath}/mailFolders?${FOLDER_SELECT}&$top=100&includeHiddenFolders=true`,
        '',
        new Set<string>(),
        budget,
      );
      // A partial tree cannot establish absence or uniqueness.
      return { folders, truncated: budget.truncated };
    }, snapshot => !snapshot.truncated, fresh);
  }

  private async fetchFolderCollection(
    initialUrl: string,
    parentPath: string,
    visitedFolderIds: Set<string>,
    // Shared across the whole recursive traversal, not per collection, so a
    // wide/deep folder tree can't fan out into hundreds of Graph requests.
    budget: { remaining: number; truncated: boolean },
  ): Promise<EmailFolder[]> {
    const folders: EmailFolder[] = [];
    const visitedUrls = new Set<string>();
    let url: string | undefined = initialUrl;

    while (url) {
      if (visitedUrls.has(url) || visitedUrls.size >= 100) {
        throw new ProviderError('PAGINATION_LIMIT', 'Folder pagination exceeded its safety limit', 'microsoft', false);
      }
      if (budget.remaining <= 0) {
        // Truncate rather than throw — see MAX_FOLDER_REQUESTS_PER_SNAPSHOT.
        budget.truncated = true;
        return folders;
      }
      visitedUrls.add(url);
      budget.remaining -= 1;
      const response = await this.client.get(url) as GraphFolderPageResponse;

      for (const graphFolder of response.value ?? []) {
        if (!graphFolder.id || visitedFolderIds.has(graphFolder.id)) continue;
        visitedFolderIds.add(graphFolder.id);
        const path = parentPath ? `${parentPath}/${graphFolder.displayName}` : graphFolder.displayName;
        folders.push(mapGraphFolder(graphFolder, path));

        if ((graphFolder.childFolderCount ?? 0) > 0) {
          folders.push(...await this.fetchFolderCollection(
            `${this.basePath}/mailFolders/${encodeGraphPathId(graphFolder.id)}/childFolders?${FOLDER_SELECT}&$top=100&includeHiddenFolders=true`,
            path,
            visitedFolderIds,
            budget,
          ));
        }
      }

      url = response['@odata.nextLink'];
    }

    return folders;
  }

  /**
   * Resolve a folder name/path/id to a Graph folder id.
   *
   * Structural writes and persistent rule destinations bypass ready snapshots
   * for fresh path→id validation, sharing any active traversal. Message moves
   * retain the ordinary 60s cache. Validation does not invalidate system IDs or
   * advance generations; successful structural mutations invalidate both caches.
   */
  private async resolveFolderId(folder: string, forWrite = false): Promise<string> {
    const trimmed = folder.trim();
    const normalized = normalizeFolderLookup(trimmed);
    const wellKnown = WELL_KNOWN_FOLDER_ALIASES[normalized]
      ?? (SYSTEM_FOLDER_NAME_SET.has(normalized) ? normalized : undefined);
    if (wellKnown) return wellKnown;

    const { folders, truncated } = await this.getFolderSnapshot(forWrite);

    // Exact id match is safe even against a truncated tree — ids are globally
    // unique, so a visible match is THE match regardless of unseen folders.
    const idMatch = folders.find(candidate => candidate.id === trimmed);
    if (idMatch) return idMatch.id;

    // A truncated tree cannot prove a NAME or PATH is unique (a duplicate could
    // exist beyond the request budget), so refuse to guess — returning a
    // visible-but-maybe-not-unique match could misroute a write. Ids only.
    if (truncated) {
      // The exact id might simply lie beyond the truncated prefix. An id is
      // globally unique, so a direct GET is a safe, O(1) way to honor
      // "exact ids resolve without depending on a full traversal".
      const directId = await this.tryResolveFolderById(trimmed);
      if (directId) return directId;

      throw new ProviderError(
        'FOLDER_TRAVERSAL_LIMIT',
        `Folder '${folder}' could not be uniquely resolved: this mailbox has more folders than a single traversal enumerates (${MAX_FOLDER_REQUESTS_PER_SNAPSHOT} requests). Specify the folder by id.`,
        'microsoft',
        false,
      );
    }

    const pathMatches = folders.filter(candidate => normalizeFolderLookup(candidate.path) === normalized);
    if (pathMatches.length === 1) return pathMatches[0]!.id;
    if (pathMatches.length > 1) {
      throw new ProviderError(
        'AMBIGUOUS_FOLDER',
        `Folder path '${folder}' is ambiguous; use the folder id`,
        'microsoft',
        false,
      );
    }

    const nameMatches = folders.filter(
      candidate => normalizeFolderLookup(candidate.displayName) === normalized,
    );
    if (nameMatches.length === 1) return nameMatches[0]!.id;
    if (nameMatches.length > 1) {
      throw new ProviderError(
        'AMBIGUOUS_FOLDER',
        `Folder name '${folder}' is ambiguous; use a full folder path`,
        'microsoft',
        false,
      );
    }

    throw new ProviderError('FOLDER_NOT_FOUND', `Folder '${folder}' was not found`, 'microsoft', false);
  }

  /**
   * Verify a string is a real folder id via a direct GET. Returns the id on a
   * 200, undefined on 404 (not an id / no such folder). Used only as a fallback
   * when the tree was truncated, so a valid id past the budget still resolves.
   */
  private async tryResolveFolderById(id: string): Promise<string | undefined> {
    try {
      const folder = await this.client.get(
        `${this.basePath}/mailFolders/${encodeGraphPathId(id)}?$select=id`,
      ) as unknown as GraphMailFolder;
      return folder.id ?? undefined;
    } catch (err) {
      if (err instanceof GraphApiError && (err.status === 404 || err.status === 400)) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Resolve a rule-action destination to an OPAQUE Graph folder id.
   *
   * Unlike the /messages/{id}/move endpoint (which accepts well-known names),
   * Graph's messageRule action contract wants a folder id — so well-known names
   * are mapped through to their ids here. Resolution is `forWrite` (fresh): a
   * rule persists and acts 24/7, so a stale destination is worth one traversal
   * to avoid. The destructive check runs on the CANONICAL resolved value, so
   * alias/slash/case tricks (`/trash/`, `DeletedItems`) that reach the same
   * folder are all rejected.
   */
  private async resolveRuleDestinationId(destination: string): Promise<string> {
    const normalized = normalizeFolderLookup(destination);
    const wellKnown = WELL_KNOWN_FOLDER_ALIASES[normalized]
      ?? (SYSTEM_FOLDER_NAME_SET.has(normalized) ? normalized : undefined);

    if (wellKnown) {
      if (DESTRUCTIVE_RULE_DESTINATIONS.has(wellKnown)) {
        throw new ProviderError(
          'UNSAFE_RULE_DESTINATION',
          `Inbox rule destination '${destination}' discards mail and is blocked for security`,
          'microsoft',
          false,
        );
      }
      const id = (await this.getSystemFolderIdMap()).get(wellKnown);
      if (!id) {
        throw new ProviderError(
          'FOLDER_NOT_FOUND',
          `Inbox rule destination '${destination}' is not provisioned on this mailbox`,
          'microsoft',
          false,
        );
      }
      return id;
    }

    const resolvedId = await this.resolveFolderId(destination, true);
    if ((await this.getDestructiveFolderIds()).has(resolvedId)) {
      throw new ProviderError(
        'UNSAFE_RULE_DESTINATION',
        `Inbox rule destination '${destination}' resolves to a mail-discarding system folder and is blocked for security`,
        'microsoft',
        false,
      );
    }
    return resolvedId;
  }

  private async folderPathFor(folder: string, folderId: string): Promise<string> {
    const normalized = normalizeFolderLookup(folder);
    const wellKnown = WELL_KNOWN_FOLDER_ALIASES[normalized]
      ?? (SYSTEM_FOLDER_NAME_SET.has(normalized) ? normalized : undefined);
    if (wellKnown) return displayNameForWellKnownFolder(wellKnown);

    const { folders } = await this.getFolderSnapshot();
    return folders.find(candidate => candidate.id === folderId)?.path ?? folder.trim();
  }

  /** Well-known-name -> resolved id for every provisioned system folder. */
  private async getSystemFolderIdMap(): Promise<Map<string, string>> {
    return this.systemFolderIdsCache.get(() => this.fetchSystemFolderIdMap(), () => true);
  }

  private async fetchSystemFolderIdMap(): Promise<Map<string, string>> {
    const idsByName = new Map<string, string>();
    for (const name of SYSTEM_FOLDER_NAMES) {
      try {
        const folder = await this.client.get(
          `${this.basePath}/mailFolders/${encodeGraphPathId(name)}?${FOLDER_SELECT}`,
        ) as unknown as GraphMailFolder;
        if (folder.id) idsByName.set(name, folder.id);
      } catch (err) {
        // Some tenants do not provision every optional system folder.
        if (err instanceof GraphApiError && err.status === 404) continue;
        throw err;
      }
    }

    return idsByName;
  }

  /** Ids of ALL system folders — none may be deleted. */
  private async getSystemFolderIds(): Promise<Set<string>> {
    return new Set((await this.getSystemFolderIdMap()).values());
  }

  /**
   * Ids of only the mail-discarding system folders. Rule destinations are
   * checked against THIS set, not the full system set: filing into Archive or
   * Junk via a rule is legitimate, so blocking every system folder would reject
   * ordinary rules. Derived from the same cached sweep as getSystemFolderIds.
   */
  private async getDestructiveFolderIds(): Promise<Set<string>> {
    const idsByName = await this.getSystemFolderIdMap();
    const ids = new Set<string>();
    for (const [name, id] of idsByName) {
      if (DESTRUCTIVE_RULE_DESTINATIONS.has(name)) ids.add(id);
    }
    return ids;
  }

  private invalidateFolderCaches(): void {
    this.folderCache.invalidate();
    this.systemFolderIdsCache.invalidate();
  }
}

function findDeferredSendProperty(
  message: Pick<GraphMessage, 'singleValueExtendedProperties'>,
): { id: string; value: string } | undefined {
  return message.singleValueExtendedProperties?.find(
    property => property.id.toLowerCase() === DEFERRED_SEND_PROPERTY.toLowerCase(),
  );
}

function decodeConversationIndex(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return undefined;

  const firstPadding = value.indexOf('=');
  if (firstPadding >= 0 && value.length % 4 !== 0) return undefined;

  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return undefined;
  const normalized = unpadded.replace(/-/g, '+').replace(/_/g, '/');

  const decoded = Buffer.from(normalized, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  if (canonical !== normalized) return undefined;
  return decoded.length;
}

function scheduledDispatchFailure(
  draftId: string,
  err: unknown,
): { outcome: 'rejected' | 'unknown'; error: EmailError } {
  // Shares classifyGraphDelivery with the immediate-send paths so the two
  // families cannot drift on what counts as ambiguous. The codes stay
  // scheduled-specific because they are spec'd and because the remedy differs:
  // here there is a tagged draft to inspect or cancel.
  const failure = classifyGraphDelivery(err);
  return {
    outcome: failure.ambiguous ? 'unknown' : 'rejected',
    error: {
      code: failure.ambiguous ? 'SCHEDULE_SEND_STATUS_UNKNOWN' : 'SCHEDULE_SEND_FAILED',
      message: failure.ambiguous
        ? `Microsoft Graph may have accepted scheduled-send submission. Do not schedule a duplicate; inspect or cancel messageId ${draftId}. ${failure.detail}`
        : `Microsoft Graph rejected scheduled-send submission; the tagged draft remains available at messageId ${draftId}. ${failure.detail}`,
      provider: 'microsoft',
      recoverable: false,
      ...(failure.retryAfter !== undefined ? { retryAfter: failure.retryAfter } : {}),
    },
  };
}

function scheduledSendNotFoundError(): ProviderError {
  return new ProviderError(
    'NOT_SCHEDULED',
    'Message is not a pending scheduled send',
    'microsoft',
    false,
  );
}

interface GraphMessage {
  id: string;
  changeKey?: string;
  subject: string;
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  ccRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  bccRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  body?: { contentType: string; content: string };
  uniqueBody?: { contentType: string; content: string };
  categories?: string[];
  conversationId?: string;
  conversationIndex?: string;
  flag?: { flagStatus?: string };
  internetMessageId?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  attachments?: GraphAttachment[];
  isDraft?: boolean;
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
}

interface GraphMessagePageResponse {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
}

interface GraphMailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
  isHidden?: boolean;
  [key: string]: unknown;
}

interface GraphFolderPageResponse {
  value?: GraphMailFolder[];
  '@odata.nextLink'?: string;
}

interface GraphRulePageResponse {
  value?: InboxRule[];
  '@odata.nextLink'?: string;
}

interface GraphAttachment {
  id: string;
  '@odata.type'?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string;
  contentBytes?: string;
}

/** A single item in a delta response — may include @removed for tombstones */
interface DeltaItem extends GraphMessage {
  '@removed'?: { reason: string };
}

/** Shape of a delta query page response */
interface DeltaPageResponse {
  value?: DeltaItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function mapGraphMessage(msg: GraphMessage): EmailMessage {
  const attachments = (msg.attachments ?? []).map((attachment): EmailAttachment => ({
    id: attachment.id,
    filename: attachment.name ?? '',
    mimeType: attachment.contentType ?? 'application/octet-stream',
    size: attachment.size ?? 0,
    isInline: attachment.isInline ?? false,
    contentId: attachment.contentId,
  }));

  const bodyHtml = msg.body?.contentType?.toLowerCase() === 'html'
    ? msg.body.content
    : undefined;
  let authoredBodyHtml: string | undefined;
  if (bodyHtml !== undefined) {
    const replyRegion = findGraphQuotedReplyRegion(bodyHtml);
    if (replyRegion) {
      authoredBodyHtml = msg.uniqueBody?.contentType?.toLowerCase() === 'html'
        && typeof msg.uniqueBody.content === 'string'
        ? msg.uniqueBody.content
        : bodyHtml.slice(replyRegion.bodyOpenEnd, replyRegion.dividerStart);
    }
  }

  return {
    id: msg.id,
    subject: msg.subject ?? '',
    from: {
      email: msg.from?.emailAddress?.address ?? '',
      name: msg.from?.emailAddress?.name,
    },
    to: (msg.toRecipients ?? []).map(r => ({
      email: r.emailAddress.address,
      name: r.emailAddress.name,
    })),
    cc: (msg.ccRecipients ?? []).map(r => ({
      email: r.emailAddress.address,
      name: r.emailAddress.name,
    })),
    // bccRecipients is only populated by Graph on the sender's own copy of a
    // message; recipients' copies omit it. Surface it when present so read_email
    // can report full recipient topology (issue #102).
    bcc: (msg.bccRecipients ?? []).map(r => ({
      email: r.emailAddress.address,
      name: r.emailAddress.name,
    })),
    receivedAt: msg.receivedDateTime ?? new Date().toISOString(),
    isRead: msg.isRead ?? false,
    isFlagged: msg.flag?.flagStatus === 'flagged',
    isDraft: msg.isDraft === true,
    hasAttachments: msg.hasAttachments ?? false,
    body: msg.body?.contentType?.toLowerCase() === 'text' ? msg.body.content : undefined,
    bodyHtml,
    authoredBodyHtml,
    attachments,
    labels: msg.categories,
    conversationId: msg.conversationId,
    messageId: msg.internetMessageId,
  };
}

function normalizeFolderId(folder: string): string {
  return WELL_KNOWN_FOLDER_ALIASES[folder.trim().toLowerCase()] ?? folder;
}

// Graph's messageRuleActions value contract. Wrong-typed values (e.g. a boolean
// moveToFolder, or a string markAsRead) are rejected locally rather than sent to
// Graph — and a non-string folder value would otherwise dodge the destructive
// destination check, which only inspects strings.
function isValidRuleActionValue(canonicalKey: string, value: unknown): boolean {
  switch (canonicalKey) {
    case 'moveToFolder':
    case 'copyToFolder':
      return typeof value === 'string' && value.trim().length > 0;
    case 'markAsRead':
    case 'stopProcessingRules':
      return typeof value === 'boolean';
    case 'markImportance':
      return value === 'low' || value === 'normal' || value === 'high';
    case 'assignCategories':
      return Array.isArray(value) && value.every(item => typeof item === 'string');
    default:
      return false;
  }
}

function normalizeFolderLookup(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

function displayNameForWellKnownFolder(folder: string): string {
  const names: Record<string, string> = {
    archive: 'Archive',
    deleteditems: 'Deleted Items',
    drafts: 'Drafts',
    inbox: 'Inbox',
    junkemail: 'Junk Email',
    outbox: 'Outbox',
    sentitems: 'Sent Items',
  };
  return names[folder] ?? folder;
}

function mapGraphFolder(folder: GraphMailFolder, path: string): EmailFolder {
  return { ...folder, path };
}

function systemFolderProtectedError(folder: string): ProviderError {
  return new ProviderError(
    'SYSTEM_FOLDER_PROTECTED',
    `System folder '${folder}' cannot be deleted`,
    'microsoft',
    false,
  );
}

/**
 * Simplify a search query by stripping field prefixes, boolean operators, and quotes.
 * Returns space-separated keywords suitable for a Graph API $search retry.
 */
export function simplifySearchQuery(query: string): string {
  return query
    // Remove field prefixes (from:, to:, subject:, body:)
    .replace(/\b(?:from|to|subject|body):/gi, '')
    // Remove boolean operators
    .replace(/\b(?:AND|OR|NOT)\b/g, '')
    // Remove quotes but keep content
    .replace(/["']/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateBody(body: string): string {
  if (Buffer.byteLength(body, 'utf-8') <= BODY_SIZE_LIMIT) return body;

  const notice = '\n\nThis response was truncated because it exceeded email size limits.';
  const target = BODY_SIZE_LIMIT - Buffer.byteLength(notice, 'utf-8');
  const truncated = Buffer.from(body, 'utf-8').subarray(0, target).toString('utf-8');
  const lastTag = truncated.lastIndexOf('>');
  const safeCut = lastTag > 0 ? lastTag + 1 : truncated.length;
  return truncated.substring(0, safeCut) + notice;
}

/**
 * Build a Graph `body` object choosing HTML vs Text based on what's populated.
 * When `bodyHtml` is set, sends as HTML; otherwise plain text (preserves newlines).
 * Content is truncated to fit Graph body size limits.
 */
function buildGraphBody(
  bodyHtml: string | undefined,
  body: string,
): { contentType: 'HTML' | 'Text'; content: string } {
  if (bodyHtml !== undefined) {
    return { contentType: 'HTML', content: truncateBody(bodyHtml) };
  }
  return { contentType: 'Text', content: truncateBody(body) };
}

interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

/**
 * Strip outer `<html>` / `<body>` wrappers from caller-supplied HTML so it can be
 * inserted as a fragment into Graph's auto-quoted reply document. `format: 'html'`
 * is a passthrough in body-renderer.ts, so callers may send full documents.
 *
 * Uses indexOf-based parsing rather than regex to avoid backtracking on
 * adversarial input (caller-supplied HTML may be untrusted).
 */
function stripHtmlBodyWrappers(html: string): string {
  const lower = html.toLowerCase();

  // Bail early if there's no <html> tag — input is already a fragment.
  const htmlOpenIdx = lower.indexOf('<html');
  if (htmlOpenIdx < 0) return html;

  let out = html;
  let outLower = lower;

  // Strip everything up to and including the opening <body...> tag, falling
  // back to the opening <html...> tag when no body is present.
  const bodyOpenIdx = outLower.indexOf('<body');
  const openTagIdx = bodyOpenIdx >= 0 ? bodyOpenIdx : htmlOpenIdx;
  const openTagEnd = outLower.indexOf('>', openTagIdx);
  if (openTagEnd >= 0) {
    out = out.slice(openTagEnd + 1);
    outLower = out.toLowerCase();
  }

  // Trim trailing whitespace, then strip up to one </html> and one </body>
  // suffix (in either order). This handles the common shapes
  // `…</body></html>`, `…</body>`, and `…</html>` produced by HTML serializers.
  for (let i = 0; i < 2; i++) {
    out = out.trimEnd();
    outLower = out.toLowerCase();
    if (outLower.endsWith('</html>')) {
      out = out.slice(0, -'</html>'.length);
      outLower = out.toLowerCase();
      continue;
    }
    if (outLower.endsWith('</body>')) {
      out = out.slice(0, -'</body>'.length);
      outLower = out.toLowerCase();
      continue;
    }
    break;
  }

  return out;
}

/**
 * Wrap plain text as a minimal HTML fragment suitable for merging into Graph's
 * auto-quoted reply document. HTML-escapes the input and converts newlines to `<br>`.
 */
function wrapPlainTextAsHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<div>${escaped.replace(/\n/g, '<br>')}</div>`;
}

/**
 * Merge a caller-supplied HTML fragment into Graph's auto-quoted reply document so
 * that Graph's `From:/Sent:/To:/Subject:` divider and the prior thread are preserved.
 *
 * Insertion strategy: place the fragment immediately after the `<body>` opening tag.
 * Graph's response begins with an `<hr>` right after `<body>`, so the caller's content
 * naturally appears above that divider — no need to add our own.
 *
 * Defensive fallback (no `<body>` tag): concatenate fragment + content.
 */
/**
 * Locate the splice region in a Graph reply draft body.
 *
 * Returns null unless the content has Graph's unambiguous reply anatomy: a
 * `<body>`, the `divRplyFwdMsg` boundary, and the `<hr>` divider immediately
 * before that boundary. Returns the anchors otherwise:
 * - `bodyOpenEnd`: index of the first character after the `<body ...>` opening tag
 * - `dividerStart`: index of Graph's `<hr ...>` divider
 *
 * Both create-path (`mergeQuotedReplyHtml`, inserts at `bodyOpenEnd`) and update-path
 * (`updateDraft`, replaces `bodyOpenEnd..dividerStart`) share this anatomy parser so
 * detection and splicing always agree on what counts as a reply draft.
 */
function findGraphQuotedReplyRegion(
  content: string,
): { bodyOpenEnd: number; dividerStart: number } | null {
  const bodyMatch = content.match(/<body[^>]*>/i);
  if (!bodyMatch || bodyMatch.index === undefined) return null;
  const bodyOpenEnd = bodyMatch.index + bodyMatch[0].length;

  const boundaryMatch = content.slice(bodyOpenEnd).match(
    /<div\b[^>]*\bid\s*=\s*(["'])divRplyFwdMsg\1[^>]*>/i,
  );
  if (!boundaryMatch || boundaryMatch.index === undefined) return null;
  const boundaryStart = bodyOpenEnd + boundaryMatch.index;

  // Match the divider adjacent to Graph's boundary, not the first <hr> in the
  // authored region. Markdown `---` legitimately renders to an authored <hr>.
  const beforeBoundary = content.slice(bodyOpenEnd, boundaryStart);
  const dividerMatch = beforeBoundary.match(/<hr\b[^>]*>\s*$/i);
  if (!dividerMatch || dividerMatch.index === undefined) return null;
  return { bodyOpenEnd, dividerStart: bodyOpenEnd + dividerMatch.index };
}

/**
 * Merge a caller-supplied HTML fragment into Graph's auto-quoted reply document so
 * that Graph's `From:/Sent:/To:/Subject:` divider and the prior thread are preserved.
 *
 * Insertion strategy: place the fragment immediately after the `<body>` opening tag.
 * Graph's response begins with an `<hr>` right after `<body>`, so the caller's content
 * naturally appears above that divider — no need to add our own.
 *
 * Defensive fallback (no recognizable Graph anatomy): concatenate fragment + content.
 */
function mergeQuotedReplyHtml(draftContent: string, callerFragment: string): string {
  const region = findGraphQuotedReplyRegion(draftContent);
  if (!region) return callerFragment + draftContent;
  return draftContent.slice(0, region.bodyOpenEnd)
    + callerFragment
    + draftContent.slice(region.bodyOpenEnd);
}

/**
 * Merge two recipient lists, deduplicating by email address case-insensitively.
 * Used to combine Graph's auto-populated reply-all recipients with caller-supplied
 * additions without dropping either set.
 */
function mergeRecipients(
  existing: GraphRecipient[],
  additions: { email: string; name?: string }[],
): GraphRecipient[] {
  const byEmail = new Map<string, GraphRecipient>();
  for (const r of existing) {
    const email = r.emailAddress?.address?.toLowerCase();
    if (email) byEmail.set(email, r);
  }
  for (const a of additions) {
    const email = a.email.toLowerCase();
    if (!byEmail.has(email)) {
      byEmail.set(email, { emailAddress: { address: a.email, name: a.name } });
    }
  }
  return Array.from(byEmail.values());
}
