// GmailEmailProvider — Gmail API email provider
import { randomBytes } from 'node:crypto';
import type {
  EmailAddress,
  EmailAttachment,
  EmailMessage,
  EmailThread,
  ComposeMessage,
  SendResult,
  DraftResult,
  ListOptions,
  ReplyOptions,
} from '@usejunior/email-core';

// Gmail label mapping
const FOLDER_TO_LABEL: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  trash: 'TRASH',
  junk: 'SPAM',
  spam: 'SPAM',
  drafts: 'DRAFT',
  starred: 'STARRED',
  important: 'IMPORTANT',
};

// Matches Microsoft's SUBJECT_MAX_LENGTH — keeps cross-provider behaviour consistent.
const SUBJECT_MAX_LENGTH = 255;

export interface GmailApiClient {
  listMessages(opts: { labelIds?: string[]; maxResults?: number; q?: string }): Promise<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }>;
  getMessage(id: string): Promise<GmailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<{ data?: string; size?: number }>;
  /**
   * Send a raw RFC 2822 message. Optional `threadId` routes the send into
   * an existing thread (used by reply flows). Existing implementations can
   * ignore the second parameter — it is additive and optional.
   */
  sendMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string }>;
  modifyMessage(id: string, opts: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<void>;
  getThread(threadId: string): Promise<{ id: string; messages: GmailMessage[] }>;
  /**
   * Create a draft from a raw RFC 2822 message. Optional `threadId` routes
   * the draft into an existing thread (used by reply-draft flows).
   */
  createDraft(raw: string, threadId?: string): Promise<{ id: string; message: { id: string; threadId: string } }>;
  sendDraft(draftId: string): Promise<{ id: string; message: { id: string; threadId: string } }>;
  /**
   * Update an existing draft by full replacement with a raw RFC 2822
   * message. Optional `threadId` preserves the draft's thread association
   * across the replace. Method is itself optional so older concrete client
   * implementations keep type-checking; `GmailEmailProvider.updateDraft`
   * falls back to a structured NOT_SUPPORTED error when this is missing.
   */
  updateDraft?(draftId: string, raw: string, threadId?: string): Promise<{ id: string; message: { id: string; threadId: string } }>;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    mimeType?: string;
    parts?: GmailMessagePart[];
  };
  internalDate?: string;
}

export class GmailEmailProvider {
  private client: GmailApiClient;

  constructor(client: GmailApiClient) {
    this.client = client;
  }

  async listMessages(opts: ListOptions): Promise<EmailMessage[]> {
    const folder = opts.folder ?? 'inbox';
    const label = FOLDER_TO_LABEL[folder] ?? folder.toUpperCase();
    const limit = opts.limit ?? 25;
    const offset = opts.offset ?? 0;

    const response = await this.client.listMessages({
      labelIds: [label],
      maxResults: offset + limit,
    });

    if (!response.messages?.length) return [];

    const page = response.messages.slice(offset);
    const messages = await Promise.all(
      page.map(m => this.client.getMessage(m.id)),
    );

    return messages.map(m => mapGmailMessage(m));
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const msg = await this.client.getMessage(id);
    return mapGmailMessage(msg);
  }

  async searchMessages(query: string, _folder?: string, limit?: number, offset?: number): Promise<EmailMessage[]> {
    const response = await this.client.listMessages({ q: query, maxResults: (offset ?? 0) + (limit ?? 50) });
    if (!response.messages?.length) return [];

    const page = response.messages.slice(offset ?? 0);
    const messages = await Promise.all(
      page.map(m => this.client.getMessage(m.id)),
    );
    return messages.map(m => mapGmailMessage(m));
  }

  async getThread(messageId: string): Promise<EmailThread> {
    const msg = await this.client.getMessage(messageId);
    const thread = await this.client.getThread(msg.threadId);

    return {
      id: thread.id,
      subject: getHeader(thread.messages[0]!, 'Subject') ?? '',
      messages: thread.messages.map(m => mapGmailMessage(m)),
      messageCount: thread.messages.length,
      isTruncated: thread.messages.length >= 100,
    };
  }

  async listAttachments(messageId: string): Promise<EmailAttachment[]> {
    const message = await this.getMessage(messageId);
    return message.attachments ?? [];
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    if (attachmentId.startsWith('part:')) {
      const message = await this.client.getMessage(messageId);
      const part = findPartByPath(message.payload?.parts, attachmentId.slice('part:'.length));
      if (!part?.body?.data) {
        throw new Error(`Gmail attachment ${attachmentId} is missing inline body data`);
      }
      return Buffer.from(part.body.data, 'base64url');
    }

    const attachment = await this.client.getAttachment(messageId, attachmentId);
    if (!attachment.data) {
      throw new Error(`Gmail attachment ${attachmentId} returned no data`);
    }
    return Buffer.from(attachment.data, 'base64url');
  }

  async sendMessage(msg: ComposeMessage): Promise<SendResult> {
    const raw = buildRawMessage(msg);
    const result = await this.client.sendMessage(raw, msg.threadId);
    return { success: true, messageId: result.id };
  }

  async replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult> {
    // Match Microsoft's createReplyAll semantics: reply to sender and cc
    // everyone else on the original message. Caller-supplied opts.cc/bcc
    // layer on top. Shipping without self-exclusion — an agent that replies
    // to its own sent mail may cc itself; documented caveat.
    const original = await this.getMessage(messageId);
    const replyAllCc = mergeAddressLists(original.to, original.cc, opts?.cc);
    const subject = prefixReSubject(original.subject);
    const references = buildReferences(original.references, original.messageId);

    const raw = buildRawMessage(
      {
        to: [original.from],
        cc: replyAllCc.length > 0 ? replyAllCc : undefined,
        bcc: opts?.bcc,
        subject,
        body,
        bodyHtml: opts?.bodyHtml,
      },
      {
        inReplyTo: original.messageId,
        references,
      },
    );

    const result = await this.client.sendMessage(raw, original.threadId);
    return { success: true, messageId: result.id };
  }

  async createDraft(msg: ComposeMessage): Promise<DraftResult> {
    const raw = buildRawMessage(msg);
    const result = await this.client.createDraft(raw, msg.threadId);
    return { success: true, draftId: result.id };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    const result = await this.client.sendDraft(draftId);
    return { success: true, messageId: result.message.id };
  }

  async createReplyDraft(messageId: string, body: string, opts?: ReplyOptions): Promise<DraftResult> {
    try {
      const original = await this.getMessage(messageId);
      const replyAllCc = mergeAddressLists(original.to, original.cc, opts?.cc);
      const subject = prefixReSubject(original.subject);
      const references = buildReferences(original.references, original.messageId);

      const raw = buildRawMessage(
        {
          to: [original.from],
          cc: replyAllCc.length > 0 ? replyAllCc : undefined,
          bcc: opts?.bcc,
          subject,
          body,
          bodyHtml: opts?.bodyHtml,
        },
        {
          inReplyTo: original.messageId,
          references,
        },
      );

      const result = await this.client.createDraft(raw, original.threadId);
      return { success: true, draftId: result.id };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'DRAFT_FAILED',
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        },
      };
    }
  }

  async updateDraft(draftId: string, msg: Partial<ComposeMessage>): Promise<DraftResult> {
    // Older downstream clients haven't adopted the new interface method yet.
    // Return the same NOT_SUPPORTED shape they saw before this PR landed so
    // those callers get a clean, backward-compatible error.
    if (!this.client.updateDraft) {
      return {
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Draft updates are not yet supported for Gmail', recoverable: false },
      };
    }

    try {
      // Gmail's drafts.update is a full replacement, not a PATCH. Fetch the
      // current draft, merge the partial over it, and re-upload. Preserve
      // threading headers from the original draft so edits don't silently
      // lose thread association.
      const current = await this.getMessage(draftId);

      const merged: ComposeMessage = {
        to: msg.to ?? current.to,
        cc: msg.cc ?? current.cc,
        bcc: msg.bcc, // bcc is never exposed on EmailMessage, so only caller can set it
        subject: msg.subject ?? current.subject,
        body: msg.body ?? current.body ?? '',
        bodyHtml: msg.bodyHtml ?? current.bodyHtml,
      };

      const raw = buildRawMessage(merged, {
        inReplyTo: current.inReplyTo,
        references: current.references,
      });

      const result = await this.client.updateDraft(draftId, raw, current.threadId);
      return { success: true, draftId: result.id };
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'UPDATE_DRAFT_FAILED',
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        },
      };
    }
  }

  // NemoClaw egress domains
  static get egressDomains(): string[] {
    return ['gmail.googleapis.com', 'oauth2.googleapis.com', 'pubsub.googleapis.com'];
  }
}

function getHeader(msg: GmailMessage, name: string): string | undefined {
  return msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function getPartHeader(part: GmailMessagePart, name: string): string | undefined {
  return part.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

function stripAngleBrackets(value: string): string {
  const match = value.trim().match(/^<(.+)>$/);
  return match ? match[1]! : value.trim();
}

function collectPayloadContent(msg: GmailMessage): {
  body?: string;
  bodyHtml?: string;
  attachments: EmailAttachment[];
} {
  let body =
    msg.payload?.body?.data && msg.payload.mimeType !== 'text/html'
      ? decodeBase64Url(msg.payload.body.data)
      : undefined;
  let bodyHtml =
    msg.payload?.body?.data && msg.payload.mimeType === 'text/html'
      ? decodeBase64Url(msg.payload.body.data)
      : undefined;
  const attachments: EmailAttachment[] = [];

  const visitPart = (part: GmailMessagePart, path: string): void => {
    const contentId = getPartHeader(part, 'Content-ID');
    const contentDisposition = getPartHeader(part, 'Content-Disposition')?.toLowerCase();
    const hasAttachmentIdentity = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    const isInline = Boolean(contentId) || Boolean(contentDisposition?.includes('inline'));

    if (!hasAttachmentIdentity && !isInline) {
      if (!body && part.mimeType === 'text/plain' && part.body?.data) {
        body = decodeBase64Url(part.body.data);
      } else if (!bodyHtml && part.mimeType === 'text/html' && part.body?.data) {
        bodyHtml = decodeBase64Url(part.body.data);
      }
    } else if (part.body?.attachmentId || part.body?.data) {
      const attachmentId = part.body?.attachmentId ?? `part:${path}`;
      const decodedSize = part.body?.data ? Buffer.from(part.body.data, 'base64url').byteLength : 0;
      attachments.push({
        id: attachmentId,
        filename: part.filename || stripAngleBrackets(contentId ?? '') || `attachment-${path.replace(/\./g, '-')}`,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body?.size ?? decodedSize,
        contentId: contentId ? stripAngleBrackets(contentId) : undefined,
        isInline,
      });
    }

    for (const [index, child] of (part.parts ?? []).entries()) {
      visitPart(child, `${path}.${index}`);
    }
  };

  for (const [index, part] of (msg.payload?.parts ?? []).entries()) {
    visitPart(part, String(index));
  }

  return { body, bodyHtml, attachments };
}

function mapGmailMessage(msg: GmailMessage): EmailMessage {
  const from = parseEmailAddress(getHeader(msg, 'From') ?? '');
  const to = (getHeader(msg, 'To') ?? '').split(',').map(a => parseEmailAddress(a.trim())).filter(a => a.email);
  const ccHeader = getHeader(msg, 'Cc');
  const cc = ccHeader
    ? ccHeader.split(',').map(a => parseEmailAddress(a.trim())).filter(a => a.email)
    : undefined;
  const subject = getHeader(msg, 'Subject') ?? '';
  const date = getHeader(msg, 'Date') ?? new Date(parseInt(msg.internalDate ?? '0', 10)).toISOString();

  // RFC 2822 threading headers — needed for reply threading on outgoing mail.
  const messageId = getHeader(msg, 'Message-ID') ?? getHeader(msg, 'Message-Id');
  const inReplyTo = getHeader(msg, 'In-Reply-To');
  const referencesRaw = getHeader(msg, 'References');
  const references = referencesRaw
    ? referencesRaw.split(/\s+/).filter(r => r.length > 0)
    : undefined;

  const { body, bodyHtml, attachments } = collectPayloadContent(msg);

  const labels = msg.labelIds ?? [];

  return {
    id: msg.id,
    subject,
    from,
    to,
    cc,
    receivedAt: date,
    isRead: !labels.includes('UNREAD'),
    hasAttachments: attachments.length > 0,
    body,
    bodyHtml,
    threadId: msg.threadId,
    messageId,
    inReplyTo,
    references,
    labels,
    folder: labels.includes('INBOX') ? 'inbox' : labels.includes('SENT') ? 'sent' : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function findPartByPath(parts: GmailMessagePart[] | undefined, path: string): GmailMessagePart | null {
  if (!parts) return null;
  const indices = path.split('.').map(segment => Number.parseInt(segment, 10));
  let current: GmailMessagePart | undefined;
  let currentParts = parts;
  for (const index of indices) {
    current = currentParts[index];
    if (!current) return null;
    currentParts = current.parts ?? [];
  }
  return current ?? null;
}

function parseEmailAddress(raw: string): { email: string; name?: string } {
  const match = raw.match(/(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?/);
  if (match) {
    return { email: match[2]!, name: match[1] || undefined };
  }
  return { email: raw.trim() };
}

// ---------------------------------------------------------------------------
// RFC 2822 / MIME helpers
// ---------------------------------------------------------------------------

/**
 * Strip CR/LF from header values to block header injection via user-controlled
 * subjects or names, and truncate Subject-length inputs to the Microsoft
 * SUBJECT_MAX_LENGTH so cross-provider behaviour is consistent.
 */
function escapeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, SUBJECT_MAX_LENGTH);
}

/**
 * Format a list of email addresses as a comma-joined RFC 2822 `To`/`Cc`
 * header value. Names containing characters that need quoting are wrapped
 * in double quotes; embedded CR/LF are stripped to prevent header injection.
 */
function formatAddressList(addrs: EmailAddress[]): string {
  return addrs
    .map(a => {
      const email = a.email.replace(/[\r\n]+/g, '');
      if (!a.name) return email;
      const name = a.name.replace(/[\r\n"]+/g, '');
      return `"${name}" <${email}>`;
    })
    .join(', ');
}

/**
 * Generate a unique MIME multipart boundary that does not collide with the
 * content. Retries once on collision; throws on the second (astronomically
 * unlikely) failure.
 */
function generateBoundary(content: string): string {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = `=_Part_${randomBytes(12).toString('hex')}`;
    if (!content.includes(candidate)) return candidate;
  }
  throw new Error('Failed to generate non-colliding MIME boundary');
}

interface BuildRawOptions {
  inReplyTo?: string;
  references?: string[];
}

/**
 * Assemble a raw RFC 2822 message with CRLF line endings, base64url-encoded
 * for Gmail's `drafts.create` / `messages.send` APIs.
 *
 * - When `msg.bodyHtml` is set, emits `multipart/alternative` with a
 *   plain-text part first (for text-only clients) and the HTML part second.
 * - When only `msg.body` is set, emits a single `text/plain` part.
 * - Populates `Cc`, `Bcc`, `In-Reply-To`, `References` headers when present.
 * - Sanitizes all header values to prevent CR/LF injection.
 * - `attachments` are intentionally not emitted — documented follow-up.
 */
function buildRawMessage(msg: ComposeMessage, opts: BuildRawOptions = {}): string {
  const CRLF = '\r\n';
  const headers: string[] = [];
  headers.push('MIME-Version: 1.0');
  headers.push(`To: ${formatAddressList(msg.to)}`);
  if (msg.cc && msg.cc.length > 0) headers.push(`Cc: ${formatAddressList(msg.cc)}`);
  if (msg.bcc && msg.bcc.length > 0) headers.push(`Bcc: ${formatAddressList(msg.bcc)}`);
  headers.push(`Subject: ${escapeHeader(msg.subject)}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${escapeHeader(opts.inReplyTo)}`);
  if (opts.references && opts.references.length > 0) {
    headers.push(`References: ${opts.references.map(r => r.replace(/[\r\n]+/g, '')).join(' ')}`);
  }

  const hasHtml = msg.bodyHtml !== undefined;

  if (hasHtml) {
    // Boundary must not appear in either part; check against both the plain
    // body and the html body.
    const boundary = generateBoundary(msg.body + (msg.bodyHtml ?? ''));
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    const sections: string[] = [];
    sections.push(headers.join(CRLF));
    sections.push(''); // blank line terminates headers

    // Plain-text part
    sections.push(`--${boundary}`);
    sections.push('Content-Type: text/plain; charset=utf-8');
    sections.push('Content-Transfer-Encoding: 7bit');
    sections.push('');
    sections.push(msg.body);

    // HTML part
    sections.push(`--${boundary}`);
    sections.push('Content-Type: text/html; charset=utf-8');
    sections.push('Content-Transfer-Encoding: 7bit');
    sections.push('');
    sections.push(msg.bodyHtml!);

    // Close boundary
    sections.push(`--${boundary}--`);
    sections.push('');

    return Buffer.from(sections.join(CRLF)).toString('base64url');
  }

  // Single-part text/plain fallback
  headers.push('Content-Type: text/plain; charset=utf-8');
  const lines = [...headers, '', msg.body];
  return Buffer.from(lines.join(CRLF)).toString('base64url');
}

/**
 * Merge the "to" and "cc" of an original message into a single cc list for
 * reply-all, preserving order and de-duplicating by email address. Returns
 * a new array; inputs are not mutated.
 */
function mergeAddressLists(
  ...lists: Array<EmailAddress[] | undefined>
): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const addr of list) {
      const key = addr.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
}

/**
 * Add a `Re: ` prefix to a subject unless one already exists. Case-insensitive
 * match — `RE:`, `re:`, and `Re:` all count as already prefixed.
 */
function prefixReSubject(subject: string): string {
  if (/^re:\s*/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

/**
 * Build the `References` header list for a reply: the original message's
 * existing references followed by its own Message-ID. Filters undefined
 * entries so missing Message-IDs don't produce empty fields.
 */
function buildReferences(existing: string[] | undefined, messageId: string | undefined): string[] {
  const refs: string[] = [];
  if (existing) refs.push(...existing);
  if (messageId) refs.push(messageId);
  return refs;
}
