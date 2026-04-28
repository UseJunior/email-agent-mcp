// GraphEmailProvider — Microsoft Graph API email provider
import type {
  EmailAttachment,
  EmailMessage,
  EmailThread,
  ComposeMessage,
  SendResult,
  DraftResult,
  ListOptions,
  ReplyOptions,
  EmailReader,
  EmailSender,
  EmailCategorizer,
} from '@usejunior/email-core';

const BODY_SIZE_LIMIT = 3.5 * 1024 * 1024; // 3.5MB
const SUBJECT_MAX_LENGTH = 255;

// Sent message tracking via custom extended property
const TRACKING_PROPERTY = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name AgentEmailTrackingId';

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

export interface GraphApiClient {
  get(url: string): Promise<{ value?: unknown[]; [key: string]: unknown }>;
  post(url: string, body?: unknown): Promise<{ id?: string; [key: string]: unknown }>;
  patch(url: string, body: unknown): Promise<void>;
  delete(url: string): Promise<void>;
}

/** Delta query select fields for efficiency */
const DELTA_SELECT = '$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,isRead,id';
// Attachments are polymorphic: $select against the base type fails for derived-only props.
// `contentId` lives on fileAttachment, not on the abstract attachment base, so it must be
// qualified with the OData type cast or Graph returns HTTP 400.
//   base attachment: https://learn.microsoft.com/en-us/graph/api/resources/attachment
//   fileAttachment:  https://learn.microsoft.com/en-us/graph/api/resources/fileattachment
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId';

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
  private getToken: () => Promise<string>;
  private onAuthError?: () => Promise<boolean>;

  constructor(getToken: () => Promise<string>, onAuthError?: () => Promise<boolean>) {
    this.getToken = getToken;
    this.onAuthError = onAuthError;
  }

  /** Fetch with automatic retry on 401 if onAuthError callback is provided. */
  private async fetchWithAuthRetry(url: string, init: RequestInit): Promise<Response> {
    const resp = await fetch(url, init);
    if (resp.status === 401 && this.onAuthError) {
      const ok = await this.onAuthError();
      if (ok) {
        const newToken = await this.getToken();
        const retryHeaders = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${newToken}` };
        return fetch(url, { ...init, headers: retryHeaders });
      }
    }
    return resp;
  }

  async get(url: string): Promise<{ value?: unknown[]; [key: string]: unknown }> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await this.fetchWithAuthRetry(fullUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new GraphApiError(resp.status, await resp.text());
    }
    return resp.json() as Promise<{ value?: unknown[]; [key: string]: unknown }>;
  }

  async post(url: string, body?: unknown): Promise<{ id?: string; [key: string]: unknown }> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method: 'POST', headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const resp = await this.fetchWithAuthRetry(fullUrl, init);
    // sendMail returns 202 with no body
    if (resp.status === 202) return {};
    if (!resp.ok) {
      throw new GraphApiError(resp.status, await resp.text());
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new GraphApiError(resp.status, await resp.text());
    }
  }

  async delete(url: string): Promise<void> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await this.fetchWithAuthRetry(fullUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new GraphApiError(resp.status, await resp.text());
    }
  }
}

export class GraphApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Graph API error ${status}: ${body.slice(0, 200)}`);
    this.name = 'GraphApiError';
  }
}

export class GraphEmailProvider implements EmailReader, EmailSender, EmailCategorizer {
  private client: GraphApiClient;
  private basePath: string;

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
    const url = `${this.basePath}/mailFolders/${folder}/messages?${params}`;
    const response = await this.client.get(url);
    return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const expandedUrl = `${this.basePath}/messages/${id}?$expand=attachments($select=${ATTACHMENT_SELECT})`;

    try {
      const response = await this.client.get(expandedUrl) as unknown as GraphMessage;
      return mapGraphMessage(response);
    } catch (err) {
      // Some mailboxes reject nested $select inside $expand; fall back to a
      // second metadata-only attachments request rather than dropping data.
      if (!(err instanceof GraphApiError) || err.status !== 400) throw err;
    }

    const message = await this.client.get(`${this.basePath}/messages/${id}`) as unknown as GraphMessage;
    const attachments = await this.client.get(
      `${this.basePath}/messages/${id}/attachments?$select=${ATTACHMENT_SELECT}`,
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
      ? `${this.basePath}/mailFolders/${normalizedFolder}/messages`
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
      const response = await this.client.get(`${this.basePath}/messages?${params}`);
      const messages = ((response.value ?? []) as GraphMessage[])
        .map(mapGraphMessage)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

      return {
        id: conversationId,
        subject: message.subject,
        messages,
        messageCount: messages.length,
      };
    }

    return { id: messageId, subject: message.subject, messages: [message], messageCount: 1 };
  }

  async applyLabels(messageId: string, labels: string[]): Promise<void> {
    const existingCategories = await this.getMessageCategories(messageId);
    const categories = [...new Set([...existingCategories, ...labels])];
    await this.client.patch(`${this.basePath}/messages/${messageId}`, { categories });
  }

  async removeLabels(messageId: string, labels: string[]): Promise<void> {
    const labelsToRemove = new Set(labels);
    const existingCategories = await this.getMessageCategories(messageId);
    const categories = existingCategories.filter(label => !labelsToRemove.has(label));
    await this.client.patch(`${this.basePath}/messages/${messageId}`, { categories });
  }

  async setFlag(messageId: string, flagged: boolean): Promise<void> {
    await this.client.patch(`${this.basePath}/messages/${messageId}`, {
      flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
    });
  }

  async setReadState(messageId: string, isRead: boolean): Promise<void> {
    await this.client.patch(`${this.basePath}/messages/${messageId}`, { isRead });
  }

  async moveToFolder(messageId: string, folder: string): Promise<string> {
    // Graph POST /move returns the moved message with a NEW id
    const result = await this.client.post(`${this.basePath}/messages/${messageId}/move`, {
      destinationId: normalizeFolderId(folder),
    });
    return result.id ?? messageId;
  }

  async deleteMessage(messageId: string, hard = false): Promise<void> {
    if (hard) {
      await this.client.post(`${this.basePath}/messages/${messageId}/permanentDelete`);
      return;
    }

    await this.moveToFolder(messageId, 'deleteditems');
  }

  async sendMessage(msg: ComposeMessage): Promise<SendResult> {
    const trackingId = msg.trackingId ?? `ae-${Date.now()}`;
    const graphMsg = {
      subject: msg.subject.slice(0, SUBJECT_MAX_LENGTH),
      body: buildGraphBody(msg.bodyHtml, msg.body),
      toRecipients: msg.to.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
      ccRecipients: msg.cc?.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
      singleValueExtendedProperties: [
        { id: TRACKING_PROPERTY, value: trackingId },
      ],
    };

    await this.client.post(`${this.basePath}/sendMail`, { message: graphMsg });
    // sendMail returns 202 with no body — use tracking ID for sent message lookup
    return { success: true, messageId: trackingId };
  }

  async replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult> {
    // Routes to createReply or createReplyAll based on opts.replyAll. Both Graph
    // endpoints preserve embedded images, CID references, and the auto-quoted thread.
    try {
      const draftId = await this.prepareReplyDraft(messageId, body, opts);
      await this.client.post(`${this.basePath}/messages/${draftId}/send`, {});
      return { success: true, messageId: draftId };
    } catch {
      // Fallback to sendMail on 404 (original deleted) or other failures
    }

    // Fallback: construct reply manually via sendMail
    return this.sendMessage({
      to: opts?.cc ?? [],
      subject: `Re: `,
      body,
      bodyHtml: opts?.bodyHtml,
    });
  }

  async createDraft(msg: ComposeMessage): Promise<DraftResult> {
    const graphMsg = {
      subject: msg.subject,
      body: buildGraphBody(msg.bodyHtml, msg.body),
      toRecipients: msg.to.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
    };

    const response = await this.client.post(`${this.basePath}/messages`, graphMsg);
    return { success: true, draftId: response.id };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    await this.client.post(`${this.basePath}/messages/${draftId}/send`, {});
    return { success: true, messageId: draftId };
  }

  async createReplyDraft(messageId: string, body: string, opts?: ReplyOptions): Promise<DraftResult> {
    // Routes to createReply or createReplyAll based on opts.replyAll. Both Graph
    // endpoints preserve embedded images, CID references, and the auto-quoted thread.
    try {
      const draftId = await this.prepareReplyDraft(messageId, body, opts);
      return { success: true, draftId };
    } catch (err) {
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
  private async prepareReplyDraft(
    messageId: string,
    body: string,
    opts?: ReplyOptions,
  ): Promise<string> {
    const endpoint = opts?.replyAll === false ? 'createReply' : 'createReplyAll';
    const draft = await this.client.post(
      `${this.basePath}/messages/${messageId}/${endpoint}`,
      {},
    );
    if (!draft.id) throw new Error(`${endpoint} did not return a draft id`);

    let draftBody = draft.body as { contentType?: string; content?: string } | undefined;
    let draftCc = (draft.ccRecipients as GraphRecipient[] | undefined) ?? [];
    let draftBcc = (draft.bccRecipients as GraphRecipient[] | undefined) ?? [];

    // Fallback GET when the POST response lacks a usable HTML body. Graph defaults
    // to HTML on `Get message` so no Prefer header is needed.
    if (typeof draftBody?.content !== 'string' || draftBody.contentType?.toLowerCase() !== 'html') {
      const fetched = await this.client.get(`${this.basePath}/messages/${draft.id}`);
      draftBody = fetched.body as { contentType?: string; content?: string } | undefined;
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
    };

    const ccMerged = mergeRecipients(draftCc, opts?.cc ?? []);
    if (ccMerged.length > 0) patch.ccRecipients = ccMerged;

    const bccMerged = mergeRecipients(draftBcc, opts?.bcc ?? []);
    if (bccMerged.length > 0) patch.bccRecipients = bccMerged;

    await this.client.patch(`${this.basePath}/messages/${draft.id}`, patch);
    return draft.id;
  }

  async updateDraft(draftId: string, msg: Partial<ComposeMessage>): Promise<DraftResult> {
    const patch: Record<string, unknown> = {};
    if (msg.body !== undefined || msg.bodyHtml !== undefined) {
      patch.body = buildGraphBody(msg.bodyHtml, msg.body ?? '');
    }
    if (msg.subject !== undefined) patch.subject = msg.subject.slice(0, SUBJECT_MAX_LENGTH);
    if (msg.to) patch.toRecipients = msg.to.map(r => ({ emailAddress: { address: r.email, name: r.name } }));
    if (msg.cc) patch.ccRecipients = msg.cc.map(r => ({ emailAddress: { address: r.email, name: r.name } }));

    await this.client.patch(`${this.basePath}/messages/${draftId}`, patch);
    return { success: true, draftId };
  }

  /**
   * Get new inbox messages received after a given timestamp.
   * Uses simple $filter=receivedDateTime gt {since} — instant, no full-inbox sync.
   * This is the primary method for the watcher polling loop.
   */
  async getNewMessages(since: string): Promise<EmailMessage[]> {
    const filter = `receivedDateTime ge ${since}`;
    const params = `$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime desc&$top=50&${DELTA_SELECT}`;
    const url = `${this.basePath}/mailFolders/Inbox/messages?${params}`;
    const response = await this.client.get(url);
    return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
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

    // Page through all results (follow @odata.nextLink until @odata.deltaLink)
    while (url) {
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
        // No nextLink and no deltaLink — shouldn't happen, but break to avoid infinite loop
        break;
      }
    }

    return {
      messages: allMessages,
      nextDeltaLink: finalDeltaLink || url,
    };
  }

  // NemoClaw egress domains
  static get egressDomains(): string[] {
    return ['graph.microsoft.com', 'login.microsoftonline.com'];
  }

  private async getMessageCategories(messageId: string): Promise<string[]> {
    const response = await this.client.get(
      `${this.basePath}/messages/${messageId}?$select=categories`,
    ) as { categories?: unknown };

    return Array.isArray(response.categories)
      ? response.categories.filter((value): value is string => typeof value === 'string')
      : [];
  }
}

interface GraphMessage {
  id: string;
  subject: string;
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  ccRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  body?: { contentType: string; content: string };
  categories?: string[];
  conversationId?: string;
  flag?: { flagStatus?: string };
  internetMessageId?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  attachments?: GraphAttachment[];
}

interface GraphAttachment {
  id: string;
  '@odata.type'?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string;
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
    receivedAt: msg.receivedDateTime ?? new Date().toISOString(),
    isRead: msg.isRead ?? false,
    isFlagged: msg.flag?.flagStatus === 'flagged',
    hasAttachments: msg.hasAttachments ?? false,
    body: msg.body?.contentType?.toLowerCase() === 'text' ? msg.body.content : undefined,
    bodyHtml: msg.body?.contentType?.toLowerCase() === 'html' ? msg.body.content : undefined,
    attachments,
    labels: msg.categories,
    conversationId: msg.conversationId,
    messageId: msg.internetMessageId,
  };
}

function normalizeFolderId(folder: string): string {
  return WELL_KNOWN_FOLDER_ALIASES[folder.trim().toLowerCase()] ?? folder;
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
function mergeQuotedReplyHtml(draftContent: string, callerFragment: string): string {
  const bodyTagMatch = draftContent.match(/<body[^>]*>/i);
  if (!bodyTagMatch || bodyTagMatch.index === undefined) {
    return callerFragment + draftContent;
  }
  const insertAt = bodyTagMatch.index + bodyTagMatch[0].length;
  return draftContent.slice(0, insertAt) + callerFragment + draftContent.slice(insertAt);
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
