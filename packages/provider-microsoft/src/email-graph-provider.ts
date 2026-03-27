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

/** Delta query select fields for efficiency */
const DELTA_SELECT = '$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,isRead,id';

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

  constructor(getToken: () => Promise<string>) {
    this.getToken = getToken;
  }

  async get(url: string): Promise<{ value?: unknown[]; [key: string]: unknown }> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new GraphApiError(resp.status, await resp.text());
    }
    return resp.json() as Promise<{ value?: unknown[]; [key: string]: unknown }>;
  }

  async post(url: string, body: unknown): Promise<{ id?: string; [key: string]: unknown }> {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
    const resp = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
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
    const resp = await fetch(fullUrl, {
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
    const resp = await fetch(fullUrl, {
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

export class GraphEmailProvider {
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
    params.set('$orderby', 'receivedDateTime desc');

    const filters: string[] = [];
    if (opts.unread) filters.push('isRead eq false');
    if (opts.from) filters.push(`from/emailAddress/address eq '${opts.from}'`);
    if (filters.length > 0) params.set('$filter', filters.join(' and '));

    const folder = opts.folder ?? 'inbox';
    const url = `${this.basePath}/mailFolders/${folder}/messages?${params}`;
    const response = await this.client.get(url);
    return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const response = await this.client.get(`${this.basePath}/messages/${id}`) as unknown as GraphMessage;
    return mapGraphMessage(response);
  }

  async searchMessages(query: string): Promise<EmailMessage[]> {
    const params = new URLSearchParams();
    params.set('$search', `"${query}"`);
    const response = await this.client.get(`${this.basePath}/messages?${params}`);
    return ((response.value ?? []) as GraphMessage[]).map(mapGraphMessage);
  }

  async getThread(messageId: string): Promise<EmailThread> {
    const message = await this.getMessage(messageId);
    const conversationId = message.conversationId;

    if (conversationId) {
      const params = new URLSearchParams();
      params.set('$filter', `conversationId eq '${conversationId}'`);
      params.set('$orderby', 'receivedDateTime asc');
      const response = await this.client.get(`${this.basePath}/messages?${params}`);
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

    await this.client.post(`${this.basePath}/sendMail`, { message: graphMsg });
    // sendMail returns 202 with no body — use tracking ID for sent message lookup
    return { success: true, messageId: trackingId };
  }

  async replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult> {
    // Use createReplyAll to preserve embedded images and CID references
    try {
      const draft = await this.client.post(
        `${this.basePath}/messages/${messageId}/createReplyAll`,
        {},
      );

      if (draft.id) {
        // Update draft body
        await this.client.patch(`${this.basePath}/messages/${draft.id}`, {
          body: { contentType: 'HTML', content: truncateBody(body) },
        });

        // Send the draft
        await this.client.post(`${this.basePath}/messages/${draft.id}/send`, {});
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

    const response = await this.client.post(`${this.basePath}/messages`, graphMsg);
    return { success: true, draftId: response.id };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    await this.client.post(`${this.basePath}/messages/${draftId}/send`, {});
    return { success: true, messageId: draftId };
  }

  /**
   * Delta Query polling for watcher (no public URL needed).
   *
   * - Uses $select for efficiency
   * - Follows all @odata.nextLink pages until a @odata.deltaLink is received
   * - Filters out @removed tombstones (deleted/moved messages)
   * - Returns both messages AND the deltaLink for persistence
   */
  async getDeltaMessages(deltaLink?: string): Promise<DeltaResult> {
    // Build initial URL: use saved deltaLink, or start fresh with $select
    let url = deltaLink ?? `${this.basePath}/mailFolders/Inbox/messages/delta?${DELTA_SELECT}`;

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
