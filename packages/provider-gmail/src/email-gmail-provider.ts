// GmailEmailProvider — Gmail API email provider
import type { EmailMessage, EmailThread, ComposeMessage, SendResult, DraftResult, ListOptions, ReplyOptions } from '@usejunior/email-core';

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

export interface GmailApiClient {
  listMessages(opts: { labelIds?: string[]; maxResults?: number; q?: string }): Promise<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }>;
  getMessage(id: string): Promise<GmailMessage>;
  sendMessage(raw: string): Promise<{ id: string; threadId: string }>;
  modifyMessage(id: string, opts: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<void>;
  getThread(threadId: string): Promise<{ id: string; messages: GmailMessage[] }>;
  createDraft(raw: string): Promise<{ id: string; message: { id: string; threadId: string } }>;
  sendDraft(draftId: string): Promise<{ id: string; message: { id: string; threadId: string } }>;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    mimeType?: string;
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string; attachmentId?: string; size?: number };
      filename?: string;
      headers?: Array<{ name: string; value: string }>;
    }>;
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

    const response = await this.client.listMessages({
      labelIds: [label],
      maxResults: opts.limit ?? 25,
    });

    if (!response.messages?.length) return [];

    const messages = await Promise.all(
      response.messages.map(m => this.client.getMessage(m.id)),
    );

    return messages.map(m => mapGmailMessage(m));
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const msg = await this.client.getMessage(id);
    return mapGmailMessage(msg);
  }

  async searchMessages(query: string): Promise<EmailMessage[]> {
    const response = await this.client.listMessages({ q: query });
    if (!response.messages?.length) return [];

    const messages = await Promise.all(
      response.messages.map(m => this.client.getMessage(m.id)),
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

  async sendMessage(msg: ComposeMessage): Promise<SendResult> {
    const raw = buildRawMessage(msg);
    const result = await this.client.sendMessage(raw);
    return { success: true, messageId: result.id };
  }

  async replyToMessage(messageId: string, body: string, _opts?: ReplyOptions): Promise<SendResult> {
    const original = await this.getMessage(messageId);
    const replyMsg: ComposeMessage = {
      to: [original.from],
      subject: `Re: ${original.subject}`,
      body,
    };
    return this.sendMessage(replyMsg);
  }

  async createDraft(msg: ComposeMessage): Promise<DraftResult> {
    const raw = buildRawMessage(msg);
    const result = await this.client.createDraft(raw);
    return { success: true, draftId: result.id };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    const result = await this.client.sendDraft(draftId);
    return { success: true, messageId: result.message.id };
  }

  async createReplyDraft(_messageId: string, _body: string, _opts?: ReplyOptions): Promise<DraftResult> {
    return {
      success: false,
      error: { code: 'NOT_SUPPORTED', message: 'Reply drafts are not yet supported for Gmail', recoverable: false },
    };
  }

  async updateDraft(_draftId: string, _msg: Partial<ComposeMessage>): Promise<DraftResult> {
    return {
      success: false,
      error: { code: 'NOT_SUPPORTED', message: 'Draft updates are not yet supported for Gmail', recoverable: false },
    };
  }

  // NemoClaw egress domains
  static get egressDomains(): string[] {
    return ['gmail.googleapis.com', 'oauth2.googleapis.com', 'pubsub.googleapis.com'];
  }
}

function getHeader(msg: GmailMessage, name: string): string | undefined {
  return msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function mapGmailMessage(msg: GmailMessage): EmailMessage {
  const from = parseEmailAddress(getHeader(msg, 'From') ?? '');
  const to = (getHeader(msg, 'To') ?? '').split(',').map(a => parseEmailAddress(a.trim())).filter(a => a.email);
  const subject = getHeader(msg, 'Subject') ?? '';
  const date = getHeader(msg, 'Date') ?? new Date(parseInt(msg.internalDate ?? '0', 10)).toISOString();

  // Get body content
  let body: string | undefined;
  let bodyHtml: string | undefined;
  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8');
  }
  if (msg.payload?.parts) {
    for (const part of msg.payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        bodyHtml = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
  }

  const labels = msg.labelIds ?? [];

  return {
    id: msg.id,
    subject,
    from,
    to,
    receivedAt: date,
    isRead: !labels.includes('UNREAD'),
    hasAttachments: msg.payload?.parts?.some(p => !!p.filename) ?? false,
    body,
    bodyHtml,
    threadId: msg.threadId,
    labels,
    folder: labels.includes('INBOX') ? 'inbox' : labels.includes('SENT') ? 'sent' : undefined,
  };
}

function parseEmailAddress(raw: string): { email: string; name?: string } {
  const match = raw.match(/(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?/);
  if (match) {
    return { email: match[2]!, name: match[1] || undefined };
  }
  return { email: raw.trim() };
}

function buildRawMessage(msg: ComposeMessage): string {
  const lines = [
    `To: ${msg.to.map(r => r.name ? `"${r.name}" <${r.email}>` : r.email).join(', ')}`,
    `Subject: ${msg.subject}`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    msg.body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}
