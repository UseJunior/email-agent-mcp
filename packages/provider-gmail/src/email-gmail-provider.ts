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
  DownloadedAttachment,
  OutboundAttachment,
} from '@usejunior/email-core';
import { AttachmentNotFoundError } from '@usejunior/email-core';

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

  async downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment> {
    // Gmail's getAttachment endpoint returns only base64 bytes — it doesn't
    // include filename/mimeType. Pull metadata from the message payload
    // alongside the bytes so the action layer gets a self-contained result.
    let message: GmailMessage;
    try {
      message = await this.client.getMessage(messageId);
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new AttachmentNotFoundError(`Gmail message ${messageId} not found`);
      }
      throw err;
    }
    const meta = findAttachmentMetadata(message.payload?.parts, attachmentId);

    let content: Buffer;
    if (attachmentId.startsWith('part:')) {
      const part = findPartByPath(message.payload?.parts, attachmentId.slice('part:'.length));
      if (!part?.body?.data) {
        throw new AttachmentNotFoundError(`Gmail attachment ${attachmentId} is missing inline body data`);
      }
      content = Buffer.from(part.body.data, 'base64url');
    } else {
      let attachment: { data?: string; size?: number };
      try {
        attachment = await this.client.getAttachment(messageId, attachmentId);
      } catch (err) {
        if (isNotFoundError(err)) {
          throw new AttachmentNotFoundError(`Gmail attachment ${attachmentId} not found on message ${messageId}`);
        }
        throw err;
      }
      if (!attachment.data) {
        throw new AttachmentNotFoundError(`Gmail attachment ${attachmentId} returned no data`);
      }
      content = Buffer.from(attachment.data, 'base64url');
    }

    return {
      content,
      filename: meta?.filename || attachmentId,
      mimeType: meta?.mimeType ?? 'application/octet-stream',
      size: content.length,
    };
  }

  async sendMessage(msg: ComposeMessage): Promise<SendResult> {
    const raw = buildRawMessage(msg);
    const result = await this.client.sendMessage(raw, msg.threadId);
    return { success: true, messageId: result.id };
  }

  async replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult> {
    // Default reply-all: cc every other thread participant (matches Microsoft's
    // createReplyAll semantics). When opts.replyAll is explicitly false, reply
    // only to the original sender. Caller-supplied opts.cc/bcc layer on top
    // either way. No self-exclusion — an agent that replies to its own sent
    // mail may cc itself; documented caveat.
    const original = await this.getMessage(messageId);
    const replyCc = opts?.replyAll === false
      ? (opts?.cc ?? [])
      : mergeAddressLists(original.to, original.cc, opts?.cc);
    const subject = prefixReSubject(original.subject);
    const references = buildReferences(original.references, original.messageId);

    const raw = buildRawMessage(
      {
        to: [original.from],
        cc: replyCc.length > 0 ? replyCc : undefined,
        bcc: opts?.bcc,
        subject,
        body,
        bodyHtml: opts?.bodyHtml,
        attachments: opts?.attachments,
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
      const replyCc = opts?.replyAll === false
        ? (opts?.cc ?? [])
        : mergeAddressLists(original.to, original.cc, opts?.cc);
      const subject = prefixReSubject(original.subject);
      const references = buildReferences(original.references, original.messageId);

      const raw = buildRawMessage(
        {
          to: [original.from],
          cc: replyCc.length > 0 ? replyCc : undefined,
          bcc: opts?.bcc,
          subject,
          body,
          bodyHtml: opts?.bodyHtml,
          attachments: opts?.attachments,
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

      // Attachments: drafts.update is a full replacement, so an omitted
      // `attachments` field must be rehydrated from the existing draft or it
      // would be silently dropped. When the caller supplies `attachments`
      // (possibly an empty array), that set replaces the existing one.
      let attachments: OutboundAttachment[] | undefined;
      if (msg.attachments !== undefined) {
        attachments = msg.attachments;
      } else if (current.attachments && current.attachments.length > 0) {
        // Inline (CID) parts cannot be safely round-tripped: this builder
        // re-emits attachments with `Content-Disposition: attachment`, which
        // would orphan the `cid:` references in the preserved HTML body.
        // Fail closed and tell the caller to pass `attachments` explicitly.
        if (current.attachments.some(att => att.isInline)) {
          return {
            success: false,
            error: {
              code: 'INLINE_ATTACHMENTS_UNSUPPORTED',
              message: 'This draft has inline (CID) attachments that cannot be preserved automatically. Pass an explicit `attachments` array to update it.',
              recoverable: false,
            },
          };
        }
        attachments = [];
        for (const att of current.attachments) {
          // Gmail attachment bytes are keyed by the backing message id, not
          // the draft id — use current.id (the resolved message).
          const dl = await this.downloadAttachment(current.id, att.id);
          attachments.push({ filename: dl.filename, content: dl.content, mimeType: dl.mimeType });
        }
      }

      const merged: ComposeMessage = {
        to: msg.to ?? current.to,
        cc: msg.cc ?? current.cc,
        bcc: msg.bcc, // bcc is never exposed on EmailMessage, so only caller can set it
        subject: msg.subject ?? current.subject,
        body: msg.body ?? current.body ?? '',
        bodyHtml: msg.bodyHtml ?? current.bodyHtml,
        attachments,
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
  // A Bcc header only survives on the sender's own copy of a message; recipients'
  // copies have it stripped. Surface it when present for full recipient topology
  // on read_email (issue #102).
  const bccHeader = getHeader(msg, 'Bcc');
  const bcc = bccHeader
    ? bccHeader.split(',').map(a => parseEmailAddress(a.trim())).filter(a => a.email)
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
    bcc,
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

// Walk the part tree looking for an attachment by id (either body.attachmentId
// for non-inline parts, or `part:<index-path>` for inline parts whose data is
// already in the message payload). Returns filename + mimeType when found.
//
// Filename fallback mirrors collectPayloadContent: real filename → stripped
// Content-ID → synthetic `attachment-<path>`. Without this, CID-only inline
// parts (common for HTML emails) regress from a meaningful name like
// `image002` to empty-string after the contract reshape.
function findAttachmentMetadata(
  parts: GmailMessagePart[] | undefined,
  attachmentId: string,
): { filename: string; mimeType: string } | null {
  if (!parts) return null;
  if (attachmentId.startsWith('part:')) {
    const path = attachmentId.slice('part:'.length);
    const part = findPartByPath(parts, path);
    if (!part) return null;
    return {
      filename: deriveAttachmentFilename(part, path),
      mimeType: part.mimeType ?? 'application/octet-stream',
    };
  }
  const find = (
    list: GmailMessagePart[],
    pathPrefix: string,
  ): { part: GmailMessagePart; path: string } | null => {
    for (const [index, p] of list.entries()) {
      const path = pathPrefix === '' ? String(index) : `${pathPrefix}.${index}`;
      if (p.body?.attachmentId === attachmentId) return { part: p, path };
      if (p.parts) {
        const hit = find(p.parts, path);
        if (hit) return hit;
      }
    }
    return null;
  };
  const found = find(parts, '');
  if (!found) return null;
  return {
    filename: deriveAttachmentFilename(found.part, found.path),
    mimeType: found.part.mimeType ?? 'application/octet-stream',
  };
}

function deriveAttachmentFilename(part: GmailMessagePart, path: string): string {
  if (part.filename) return part.filename;
  const contentId = getPartHeader(part, 'Content-ID');
  const stripped = contentId ? stripAngleBrackets(contentId) : '';
  if (stripped) return stripped;
  return `attachment-${path.replace(/\./g, '-')}`;
}

function isNotFoundError(err: unknown): boolean {
  const record = err as { code?: unknown; response?: { status?: unknown } } | null;
  if (!record || typeof record !== 'object') return false;
  if (record.code === 404) return true;
  if (record.response && typeof record.response === 'object' && record.response.status === 404) return true;
  return false;
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

const CRLF = '\r\n';

/**
 * Encode text as quoted-printable (RFC 2045) with CRLF line endings and
 * 76-char soft line wrapping. Replaces the previous `7bit` labelling, which
 * was incorrect for UTF-8 bodies, and normalizes embedded `\n` to canonical
 * CRLF inside the part.
 */
function encodeQuotedPrintable(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const outLines: string[] = [];

  for (const line of normalized.split('\n')) {
    const bytes = Buffer.from(line, 'utf-8');
    const tokens: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const isLast = i === bytes.length - 1;
      if (b === 0x20 || b === 0x09) {
        // Space/tab: literal, except a trailing one must be encoded so it
        // survives transport whitespace stripping.
        tokens.push(isLast ? `=${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b));
      } else if (b >= 0x21 && b <= 0x7e && b !== 0x3d) {
        tokens.push(String.fromCharCode(b));
      } else {
        tokens.push(`=${b.toString(16).toUpperCase().padStart(2, '0')}`);
      }
    }
    // Soft-wrap so no line (including the trailing '=') exceeds 76 chars.
    // Tokens are atomic (1 char or a 3-char '=XX') and never split.
    let current = '';
    for (const tok of tokens) {
      if (current.length + tok.length > 75) {
        outLines.push(current + '=');
        current = '';
      }
      current += tok;
    }
    outLines.push(current);
  }

  return outLines.join(CRLF);
}

/** Wrap a base64 string at 76 chars per line with CRLF endings (RFC 2045). */
function wrapBase64(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    out.push(b64.slice(i, i + 76));
  }
  return out.join(CRLF);
}

/** A fully serialized MIME part: headers, blank line, encoded body. */
type MimePart = string;

function serializeTextPart(content: string, contentType: 'text/plain' | 'text/html'): MimePart {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeQuotedPrintable(content),
  ].join(CRLF);
}

function serializeAttachmentPart(att: OutboundAttachment): MimePart {
  const name = att.filename.replace(/[\r\n"\\]+/g, '_') || 'attachment';
  const mimeType = att.mimeType.replace(/[\r\n";]+/g, '') || 'application/octet-stream';
  return [
    `Content-Type: ${mimeType}; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${name}"`,
    '',
    wrapBase64(att.content.toString('base64')),
  ].join(CRLF);
}

/** Join MIME parts under a fresh boundary, returning the Content-Type value and body. */
function serializeMultipart(
  subtype: 'alternative' | 'mixed',
  parts: MimePart[],
): { contentType: string; body: string } {
  const boundary = generateBoundary(parts.join(CRLF));
  const sections: string[] = [];
  for (const part of parts) {
    sections.push(`--${boundary}`);
    sections.push(part);
  }
  sections.push(`--${boundary}--`);
  return {
    contentType: `multipart/${subtype}; boundary="${boundary}"`,
    body: sections.join(CRLF),
  };
}

/** A nested multipart rendered as a single MIME part (carries its own Content-Type header). */
function multipartAsPart(subtype: 'alternative' | 'mixed', parts: MimePart[]): MimePart {
  const { contentType, body } = serializeMultipart(subtype, parts);
  return [`Content-Type: ${contentType}`, '', body].join(CRLF);
}

/**
 * Assemble a raw RFC 2822 message with CRLF line endings, base64url-encoded
 * for Gmail's `drafts.create` / `messages.send` APIs.
 *
 * - With attachments: `multipart/mixed` whose first part is the body (a
 *   nested `multipart/alternative` when bodyHtml is set, else a single
 *   text part), followed by one `fileAttachment`-style part per attachment.
 * - Without attachments: `multipart/alternative` when bodyHtml is set, else
 *   a single quoted-printable `text/plain` message.
 * - Text parts use quoted-printable so UTF-8 survives transport.
 * - Populates `Cc`, `Bcc`, `In-Reply-To`, `References` when present and
 *   sanitizes all header values to prevent CR/LF injection.
 */
function buildRawMessage(msg: ComposeMessage, opts: BuildRawOptions = {}): string {
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
  const attachments = msg.attachments ?? [];

  let body: string;

  if (attachments.length > 0) {
    const bodyPart: MimePart = hasHtml
      ? multipartAsPart('alternative', [
        serializeTextPart(msg.body, 'text/plain'),
        serializeTextPart(msg.bodyHtml!, 'text/html'),
      ])
      : serializeTextPart(msg.body, 'text/plain');
    const mixed = serializeMultipart('mixed', [bodyPart, ...attachments.map(serializeAttachmentPart)]);
    headers.push(`Content-Type: ${mixed.contentType}`);
    body = mixed.body;
  } else if (hasHtml) {
    const alt = serializeMultipart('alternative', [
      serializeTextPart(msg.body, 'text/plain'),
      serializeTextPart(msg.bodyHtml!, 'text/html'),
    ]);
    headers.push(`Content-Type: ${alt.contentType}`);
    body = alt.body;
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('Content-Transfer-Encoding: quoted-printable');
    body = encodeQuotedPrintable(msg.body);
  }

  const message = [...headers, '', body].join(CRLF);
  return Buffer.from(message, 'utf-8').toString('base64url');
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
