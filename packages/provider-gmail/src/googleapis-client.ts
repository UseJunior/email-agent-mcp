import { gmail } from '@googleapis/gmail';
import type { GmailAuthManager } from './auth.js';
import type { GmailApiClient, GmailMessage } from './email-gmail-provider.js';

interface MessageSummary {
  id?: string | null;
  threadId?: string | null;
}

interface GmailMessagesApi {
  list(args: {
    userId: string;
    labelIds?: string[];
    maxResults?: number;
    q?: string;
  }): Promise<{ data?: { messages?: MessageSummary[]; resultSizeEstimate?: number | null } }>;
  get(args: {
    userId: string;
    id: string;
    format: 'full';
  }): Promise<{ data?: GmailMessage }>;
  attachments: {
    get(args: {
      userId: string;
      messageId: string;
      id: string;
    }): Promise<{ data?: { data?: string | null; size?: number | null } }>;
  };
  send(args: {
    userId: string;
    requestBody: { raw: string; threadId?: string };
  }): Promise<{ data?: MessageSummary }>;
  modify(args: {
    userId: string;
    id: string;
    requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
  }): Promise<unknown>;
}

interface GmailDraft {
  id?: string | null;
  message?: GmailMessage;
}

interface GmailDraftsApi {
  create(args: {
    userId: string;
    requestBody: { message: { raw: string; threadId?: string } };
  }): Promise<{ data?: GmailDraft }>;
  get(args: {
    userId: string;
    id: string;
    format: 'full';
  }): Promise<{ data?: GmailDraft }>;
  send(args: {
    userId: string;
    requestBody: { id: string };
  }): Promise<{ data?: GmailDraft }>;
  update(args: {
    userId: string;
    id: string;
    requestBody: { message: { raw: string; threadId?: string } };
  }): Promise<{ data?: GmailDraft }>;
}

interface GmailThreadsApi {
  get(args: {
    userId: string;
    id: string;
    format: 'full';
  }): Promise<{ data?: { id?: string | null; messages?: GmailMessage[] } }>;
}

interface GmailApiInstance {
  users: {
    messages: GmailMessagesApi;
    drafts: GmailDraftsApi;
    threads: GmailThreadsApi;
  };
}

function buildRawRequest(raw: string, threadId?: string): { raw: string; threadId?: string } {
  return threadId ? { raw, threadId } : { raw };
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
    message: {
      id: draft.message.id,
      threadId: draft.message.threadId,
    },
  };
}

function getErrorStatus(err: unknown): number | undefined {
  const record = err as { code?: unknown; response?: { status?: unknown } } | null;
  if (!record || typeof record !== 'object') return undefined;
  if (typeof record.code === 'number') return record.code;
  if (typeof record.response?.status === 'number') return record.response.status;
  return undefined;
}

function getErrorMessage(err: unknown): string | undefined {
  const record = err as {
    message?: unknown;
    response?: { data?: { error?: { message?: unknown } } };
  } | null;
  if (!record || typeof record !== 'object') return undefined;
  if (typeof record.response?.data?.error?.message === 'string') return record.response.data.error.message;
  if (typeof record.message === 'string') return record.message;
  return undefined;
}

function shouldFallbackToDraftLookup(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 404) return true;
  if (status !== 400) return false;

  const message = getErrorMessage(err);
  return typeof message === 'string' && /invalid id value/i.test(message);
}

export class GoogleapisGmailClient implements GmailApiClient {
  private readonly api: GmailApiInstance;

  constructor(
    auth: GmailAuthManager,
    api: GmailApiInstance = gmail({
      version: 'v1',
      auth: auth.getOAuth2Client(),
    }) as unknown as GmailApiInstance,
  ) {
    this.api = api;
  }

  async listMessages(opts: {
    labelIds?: string[];
    maxResults?: number;
    q?: string;
  }): Promise<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }> {
    const response = await this.api.users.messages.list({
      userId: 'me',
      labelIds: opts.labelIds,
      maxResults: opts.maxResults,
      q: opts.q,
    });

    return {
      messages: response.data?.messages
        ?.filter((message): message is { id: string; threadId: string } => !!message.id && !!message.threadId)
        .map(message => ({ id: message.id, threadId: message.threadId })),
      resultSizeEstimate: response.data?.resultSizeEstimate ?? undefined,
    };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    try {
      const response = await this.api.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });

      if (!response.data?.id || !response.data.threadId) {
        throw new Error('Gmail API messages.get returned an incomplete message payload');
      }

      return response.data;
    } catch (err) {
      if (!shouldFallbackToDraftLookup(err)) throw err;

      const draft = await this.api.users.drafts.get({
        userId: 'me',
        id,
        format: 'full',
      });
      if (!draft.data?.message?.id || !draft.data.message.threadId) {
        throw new Error('Gmail API drafts.get returned an incomplete message payload');
      }
      return draft.data.message;
    }
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ data?: string; size?: number }> {
    const response = await this.api.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });

    return {
      data: response.data?.data ?? undefined,
      size: response.data?.size ?? undefined,
    };
  }

  async sendMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
    const response = await this.api.users.messages.send({
      userId: 'me',
      requestBody: buildRawRequest(raw, threadId),
    });

    return requireMessageSummary(response.data, 'messages.send');
  }

  async modifyMessage(id: string, opts: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<void> {
    await this.api.users.messages.modify({
      userId: 'me',
      id,
      requestBody: {
        addLabelIds: opts.addLabelIds,
        removeLabelIds: opts.removeLabelIds,
      },
    });
  }

  async getThread(threadId: string): Promise<{ id: string; messages: GmailMessage[] }> {
    const response = await this.api.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    if (!response.data?.id || !response.data.messages) {
      throw new Error('Gmail API threads.get returned an incomplete thread payload');
    }

    return {
      id: response.data.id,
      messages: response.data.messages,
    };
  }

  async createDraft(raw: string, threadId?: string): Promise<{ id: string; message: { id: string; threadId: string } }> {
    const response = await this.api.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: buildRawRequest(raw, threadId),
      },
    });

    return requireDraft(response.data, 'drafts.create');
  }

  async sendDraft(draftId: string): Promise<{ id: string; message: { id: string; threadId: string } }> {
    const response = await this.api.users.drafts.send({
      userId: 'me',
      requestBody: { id: draftId },
    });

    return requireDraft(response.data, 'drafts.send');
  }

  async updateDraft(draftId: string, raw: string, threadId?: string): Promise<{ id: string; message: { id: string; threadId: string } }> {
    const response = await this.api.users.drafts.update({
      userId: 'me',
      id: draftId,
      requestBody: {
        message: buildRawRequest(raw, threadId),
      },
    });

    return requireDraft(response.data, 'drafts.update');
  }
}
