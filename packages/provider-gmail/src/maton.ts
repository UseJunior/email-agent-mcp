import { readFile } from 'node:fs/promises';
import type { GmailApiClient, GmailMessage } from './email-gmail-provider.js';

const MATON_GMAIL_ROOT = 'https://gateway.maton.ai/google-mail/gmail/v1';
const DEFAULT_DEADLINE_MS = 90_000;

interface MatonConnectionRecord {
  app?: unknown;
  account?: unknown;
  connection_id?: unknown;
  status?: unknown;
}

interface MatonConnectionsFile {
  connections?: unknown;
}

interface MessageSummary {
  id?: string | null;
  threadId?: string | null;
}

interface GmailDraft {
  id?: string | null;
  message?: GmailMessage;
}

export interface MatonGmailConnection {
  account: string;
  connectionId: string;
}

function normalizeAccount(value: string): string {
  return value.trim().toLowerCase();
}

function assertAccount(value: string): string {
  const account = normalizeAccount(value);
  if (
    account.length < 3 ||
    account.length > 254 ||
    !account.includes('@') ||
    /[\s\u0000-\u001f\u007f]/.test(account)
  ) {
    throw new Error('Invalid Maton Gmail account');
  }
  return account;
}

function assertConnectionId(value: unknown, account: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid Maton Gmail connection id for ${account}`);
  }
  return value;
}

function encodePathSegment(value: string): string {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid Gmail resource id');
  }
  return encodeURIComponent(value);
}

function requireMessage(message: GmailMessage | undefined, op: string): GmailMessage {
  if (!message?.id || !message.threadId) {
    throw new Error(`Gmail API ${op} returned an incomplete message payload`);
  }
  return message;
}

function requireMessageSummary(summary: MessageSummary | undefined, op: string): { id: string; threadId: string } {
  if (!summary?.id || !summary.threadId) {
    throw new Error(`Gmail API ${op} returned an incomplete message summary`);
  }
  return { id: summary.id, threadId: summary.threadId };
}

function requireDraft(draft: GmailDraft | undefined, op: string): { id: string; message: { id: string; threadId: string } } {
  if (!draft?.id || !draft.message?.id || !draft.message.threadId) {
    throw new Error(`Gmail API ${op} returned an incomplete draft payload`);
  }
  return {
    id: draft.id,
    message: { id: draft.message.id, threadId: draft.message.threadId },
  };
}

export function parseMatonGmailAccounts(value: string | undefined): string[] {
  if (!value) throw new Error('EMAIL_AGENT_MCP_MATON_GMAIL_ACCOUNTS is required for Maton Gmail transport');
  const accounts = value.split(',').map(assertAccount);
  if (accounts.length === 0) throw new Error('At least one Maton Gmail account is required');
  if (new Set(accounts).size !== accounts.length) {
    throw new Error('Duplicate Maton Gmail account in configured account list');
  }
  return accounts;
}

export async function loadMatonGmailConnections(
  path: string,
  expectedAccounts: Iterable<string>,
): Promise<Map<string, MatonGmailConnection>> {
  let parsed: MatonConnectionsFile;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as MatonConnectionsFile;
  } catch (err) {
    throw new Error(
      `Unable to load Maton connections file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed.connections)) {
    throw new Error('Invalid Maton connections file: "connections" must be an array');
  }

  const expected = new Set([...expectedAccounts].map(assertAccount));
  const result = new Map<string, MatonGmailConnection>();
  for (const raw of parsed.connections as MatonConnectionRecord[]) {
    if (raw.app !== 'google-mail' || typeof raw.account !== 'string' || !raw.account.trim()) continue;
    const account = normalizeAccount(raw.account);
    if (!expected.has(account)) continue;
    if (result.has(account)) throw new Error(`Duplicate Maton Gmail connection for ${account}`);
    if (raw.status !== 'ACTIVE') throw new Error(`Maton Gmail connection for ${account} is not ACTIVE`);
    result.set(account, {
      account,
      connectionId: assertConnectionId(raw.connection_id, account),
    });
  }
  return result;
}

export function resolveMatonGmailConnection(
  connections: Map<string, MatonGmailConnection>,
  emailAddress: string,
): MatonGmailConnection {
  const account = assertAccount(emailAddress);
  const connection = connections.get(account);
  if (!connection) throw new Error(`No ACTIVE Maton Gmail connection for ${account}`);
  return connection;
}

class MatonGmailApiError extends Error {
  readonly code: number;
  readonly response: { status: number; data: { error: { message: string } } };

  constructor(status: number, message: string) {
    super(`Gmail API error ${status}: ${message}`);
    this.name = 'MatonGmailApiError';
    this.code = status;
    this.response = { status, data: { error: { message } } };
  }
}

function shouldFallbackToDraftLookup(err: unknown): boolean {
  const record = err as { code?: unknown; response?: { status?: unknown; data?: { error?: { message?: unknown } } } } | null;
  if (!record || typeof record !== 'object') return false;
  const status = typeof record.code === 'number' ? record.code : record.response?.status;
  if (status === 404) return true;
  return status === 400 &&
    typeof record.response?.data?.error?.message === 'string' &&
    /invalid id value/i.test(record.response.data.error.message);
}

export class MatonGmailApiClient implements GmailApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly connectionId: string,
    private readonly deadlineMs = DEFAULT_DEADLINE_MS,
  ) {
    if (!apiKey) throw new Error('MATON_API_KEY is required for Gmail transport');
    assertConnectionId(connectionId, 'configured mailbox');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
      throw new Error('Invalid Maton request deadline');
    }
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const url = new URL(`${MATON_GMAIL_ROOT}${path}`);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'gateway.maton.ai' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      !url.pathname.startsWith('/google-mail/gmail/v1/')
    ) {
      throw new Error('Untrusted Maton Gmail URL');
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Maton-Connection': this.connectionId,
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.deadlineMs),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 500) || response.statusText || 'request failed';
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === 'string') message = parsed.error.message.slice(0, 500);
      } catch {
        // Preserve the bounded plain-text error.
      }
      message = message
        .replaceAll(this.apiKey, '[redacted]')
        .replaceAll(this.connectionId, '[redacted]');
      throw new MatonGmailApiError(response.status, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listMessages(opts: {
    labelIds?: string[];
    maxResults?: number;
    q?: string;
    pageToken?: string;
  }): Promise<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number; nextPageToken?: string }> {
    const params = new URLSearchParams();
    for (const labelId of opts.labelIds ?? []) params.append('labelIds', labelId);
    if (opts.maxResults !== undefined) params.set('maxResults', String(opts.maxResults));
    if (opts.q !== undefined) params.set('q', opts.q);
    if (opts.pageToken) params.set('pageToken', opts.pageToken);
    const query = params.size ? `?${params.toString()}` : '';
    const response = await this.request<{
      messages?: MessageSummary[];
      resultSizeEstimate?: number | null;
      nextPageToken?: string | null;
    }>(`/users/me/messages${query}`, 'GET');
    return {
      messages: response.messages
        ?.filter((message): message is { id: string; threadId: string } => !!message.id && !!message.threadId)
        .map(message => ({ id: message.id, threadId: message.threadId })),
      resultSizeEstimate: response.resultSizeEstimate ?? undefined,
      ...(response.nextPageToken ? { nextPageToken: response.nextPageToken } : {}),
    };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    try {
      return requireMessage(
        await this.request<GmailMessage>(`/users/me/messages/${encodePathSegment(id)}?format=full`, 'GET'),
        'messages.get',
      );
    } catch (err) {
      if (!shouldFallbackToDraftLookup(err)) throw err;
      const draft = await this.request<GmailDraft>(
        `/users/me/drafts/${encodePathSegment(id)}?format=full`,
        'GET',
      );
      return requireMessage(draft.message, 'drafts.get');
    }
  }

  async getDraft(draftId: string): Promise<{ id: string; message: GmailMessage }> {
    const draft = await this.request<GmailDraft>(
      `/users/me/drafts/${encodePathSegment(draftId)}?format=full`,
      'GET',
    );
    if (!draft.id) {
      throw new Error('Gmail API drafts.get returned an incomplete draft payload');
    }
    return {
      id: draft.id,
      message: requireMessage(draft.message, 'drafts.get'),
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ data?: string; size?: number }> {
    const response = await this.request<{ data?: string | null; size?: number | null }>(
      `/users/me/messages/${encodePathSegment(messageId)}/attachments/${encodePathSegment(attachmentId)}`,
      'GET',
    );
    return { data: response.data ?? undefined, size: response.size ?? undefined };
  }

  async sendMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
    return requireMessageSummary(
      await this.request<MessageSummary>('/users/me/messages/send', 'POST', threadId ? { raw, threadId } : { raw }),
      'messages.send',
    );
  }

  async modifyMessage(id: string, opts: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<void> {
    await this.request(
      `/users/me/messages/${encodePathSegment(id)}/modify`,
      'POST',
      { addLabelIds: opts.addLabelIds, removeLabelIds: opts.removeLabelIds },
    );
  }

  async getThread(threadId: string): Promise<{ id: string; messages: GmailMessage[] }> {
    const response = await this.request<{ id?: string | null; messages?: GmailMessage[] }>(
      `/users/me/threads/${encodePathSegment(threadId)}?format=full`,
      'GET',
    );
    if (!response.id || !response.messages) {
      throw new Error('Gmail API threads.get returned an incomplete thread payload');
    }
    return { id: response.id, messages: response.messages };
  }

  async createDraft(raw: string, threadId?: string): Promise<{ id: string; message: { id: string; threadId: string } }> {
    const message = threadId ? { raw, threadId } : { raw };
    return requireDraft(
      await this.request<GmailDraft>('/users/me/drafts', 'POST', { message }),
      'drafts.create',
    );
  }

  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    return requireMessageSummary(
      await this.request<MessageSummary>('/users/me/drafts/send', 'POST', { id: draftId }),
      'drafts.send',
    );
  }

  async updateDraft(draftId: string, raw: string, threadId?: string): Promise<{ id: string; message: { id: string; threadId: string } }> {
    const message = threadId ? { raw, threadId } : { raw };
    return requireDraft(
      await this.request<GmailDraft>(
        `/users/me/drafts/${encodePathSegment(draftId)}`,
        'PUT',
        { message },
      ),
      'drafts.update',
    );
  }
}
