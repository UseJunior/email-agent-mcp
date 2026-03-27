// GraphEmailProvider — Microsoft Graph API email provider
import type {
  EmailMessage,
  EmailThread,
  ComposeMessage,
  SendResult,
  DraftResult,
  ListOptions,
  ReplyOptions,
} from '@usejunior/email-core';

const BODY_SIZE_LIMIT = 3.5 * 1024 * 1024; // 3.5MB
const SUBJECT_MAX_LENGTH = 255;

// Sent message tracking via custom extended property
const TRACKING_PROPERTY = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name AgentEmailTrackingId';

export interface GraphApiClient {
  get(url: string): Promise<{ value?: unknown[]; [key: string]: unknown }>;
  post(url: string, body: unknown): Promise<{ id?: string; [key: string]: unknown }>;
  patch(url: string, body: unknown): Promise<void>;
  delete(url: string): Promise<void>;
}

export class GraphEmailProvider {
  private client: GraphApiClient;
  private userId: string;

  constructor(client: GraphApiClient, userId = 'me') {
    this.client = client;
    this.userId = userId;
  }

  async listMessages(opts: ListOptions): Promise<EmailMessage[]> {
    const params = new URLSearchParams();
    params.set('$top', String(opts.limit ?? 25));
    params.set('$orderby', 'receivedDateTime desc');

    const filters: string[] = [];
    if (opts.unread) filters.push('isRead eq false');
    if (opts.from) filters.push(`from/emailAddress/address eq '${opts.from}'`);
    if (filters.length > 0) params.set('$filter', filters.join(' and '));

    const folder = opts.folder ?? 'inbox';
    const url = `/users/${this.userId}/mailFolders/${folder}/messages?${params}`;
    const response = await this.client.get(url);
    return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const response = await this.client.get(`/users/${this.userId}/messages/${id}`) as unknown as GraphMessage;
    return mapGraphMessage(response);
  }

  async searchMessages(query: string): Promise<EmailMessage[]> {
    const params = new URLSearchParams();
    params.set('$search', `"${query}"`);
    const response = await this.client.get(`/users/${this.userId}/messages?${params}`);
    return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
  }

  async getThread(messageId: string): Promise<EmailThread> {
    const message = await this.getMessage(messageId);
    const conversationId = message.conversationId;

    if (conversationId) {
      const params = new URLSearchParams();
      params.set('$filter', `conversationId eq '${conversationId}'`);
      params.set('$orderby', 'receivedDateTime asc');
      const response = await this.client.get(`/users/${this.userId}/messages?${params}`);
      const messages = ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);

      return {
        id: conversationId,
        subject: message.subject,
        messages,
        messageCount: messages.length,
      };
    }

    return { id: messageId, subject: message.subject, messages: [message], messageCount: 1 };
  }

  async sendMessage(msg: ComposeMessage): Promise<SendResult> {
    const trackingId = msg.trackingId ?? `ae-${Date.now()}`;
    const graphMsg = {
      subject: msg.subject.slice(0, SUBJECT_MAX_LENGTH),
      body: { contentType: 'HTML', content: truncateBody(msg.body) },
      toRecipients: msg.to.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
      ccRecipients: msg.cc?.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
      singleValueExtendedProperties: [
        { id: TRACKING_PROPERTY, value: trackingId },
      ],
    };

    const response = await this.client.post(`/users/${this.userId}/sendMail`, { message: graphMsg });
    return { success: true, messageId: response.id ?? trackingId };
  }

  async replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult> {
    // Use createReplyAll to preserve embedded images and CID references
    try {
      const draft = await this.client.post(
        `/users/${this.userId}/messages/${messageId}/createReplyAll`,
        {},
      );

      if (draft.id) {
        // Update draft body
        await this.client.patch(`/users/${this.userId}/messages/${draft.id}`, {
          body: { contentType: 'HTML', content: truncateBody(body) },
        });

        // Send the draft
        await this.client.post(`/users/${this.userId}/messages/${draft.id}/send`, {});
        return { success: true, messageId: draft.id };
      }
    } catch {
      // Fallback to sendMail on 404 (original deleted)
    }

    // Fallback: construct reply manually via sendMail
    return this.sendMessage({
      to: opts?.cc ?? [],
      subject: `Re: `,
      body,
    });
  }

  async createDraft(msg: ComposeMessage): Promise<DraftResult> {
    const graphMsg = {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.body },
      toRecipients: msg.to.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
    };

    const response = await this.client.post(`/users/${this.userId}/messages`, graphMsg);
    return { success: true, draftId: response.id };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    await this.client.post(`/users/${this.userId}/messages/${draftId}/send`, {});
    return { success: true, messageId: draftId };
  }

  // Delta Query polling for watcher (no public URL needed)
  async getDeltaMessages(deltaLink?: string): Promise<{ messages: EmailMessage[]; nextDeltaLink: string }> {
    const url = deltaLink ?? `/users/${this.userId}/mailFolders/Inbox/messages/delta`;
    const response = await this.client.get(url) as { value?: GraphMessage[]; '@odata.deltaLink'?: string };
    const messages = (response.value ?? []).map(mapGraphMessage);
    return {
      messages,
      nextDeltaLink: response['@odata.deltaLink'] ?? url,
    };
  }

  // NemoClaw egress domains
  static get egressDomains(): string[] {
    return ['graph.microsoft.com', 'login.microsoftonline.com'];
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
  conversationId?: string;
  internetMessageId?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

function mapGraphMessage(msg: GraphMessage): EmailMessage {
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
    hasAttachments: msg.hasAttachments ?? false,
    body: msg.body?.contentType === 'Text' ? msg.body.content : undefined,
    bodyHtml: msg.body?.contentType === 'HTML' ? msg.body.content : undefined,
    conversationId: msg.conversationId,
    messageId: msg.internetMessageId,
  };
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
