import { describe, expect, it, vi } from 'vitest';
import type { GmailMessage } from './email-gmail-provider.js';
import { GoogleapisGmailClient } from './googleapis-client.js';

function message(id: string, threadId: string): GmailMessage {
  return {
    id,
    threadId,
    payload: {
      headers: [
        { name: 'From', value: 'Sender <sender@example.com>' },
        { name: 'To', value: 'recipient@example.com' },
        { name: 'Subject', value: 'Hello' },
      ],
    },
  };
}

function createMockApi() {
  return {
    users: {
      messages: {
        list: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'm-1', threadId: 't-1' }], resultSizeEstimate: 1 } }),
        get: vi.fn().mockResolvedValue({ data: message('m-1', 't-1') }),
        attachments: {
          get: vi.fn().mockResolvedValue({ data: { data: Buffer.from('attachment-bytes').toString('base64url'), size: 16 } }),
        },
        send: vi.fn().mockResolvedValue({ data: { id: 'm-sent', threadId: 't-sent' } }),
        modify: vi.fn().mockResolvedValue({}),
      },
      drafts: {
        create: vi.fn().mockResolvedValue({ data: { id: 'd-1', message: { id: 'm-draft', threadId: 't-draft' } } }),
        get: vi.fn().mockResolvedValue({ data: { id: 'd-1', message: message('m-draft', 't-draft') } }),
        send: vi.fn().mockResolvedValue({ data: { id: 'd-1', message: { id: 'm-sent-draft', threadId: 't-draft' } } }),
        update: vi.fn().mockResolvedValue({ data: { id: 'd-1', message: { id: 'm-updated-draft', threadId: 't-draft' } } }),
      },
      threads: {
        get: vi.fn().mockResolvedValue({ data: { id: 't-1', messages: [message('m-1', 't-1')] } }),
      },
    },
  };
}

function createClient(api = createMockApi()): GoogleapisGmailClient {
  return new GoogleapisGmailClient(
    { getOAuth2Client: () => ({}) } as never,
    api as never,
  );
}

describe('provider-gmail/GoogleapisGmailClient', () => {
  it('Scenario: listMessages forwards Gmail list request shape', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.listMessages({
      labelIds: ['INBOX'],
      maxResults: 10,
      q: 'driver license',
    });

    expect(api.users.messages.list).toHaveBeenCalledWith({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: 10,
      q: 'driver license',
    });
    expect(result).toEqual({
      messages: [{ id: 'm-1', threadId: 't-1' }],
      resultSizeEstimate: 1,
    });
  });

  it('Scenario: getMessage requests full Gmail payload', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.getMessage('m-1');

    expect(api.users.messages.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'm-1',
      format: 'full',
    });
    expect(result.id).toBe('m-1');
    expect(result.threadId).toBe('t-1');
  });

  it('Scenario: getMessage falls back to drafts.get for draft ids', async () => {
    const api = createMockApi();
    api.users.messages.get.mockRejectedValueOnce({ code: 404 });
    const client = createClient(api);

    const result = await client.getMessage('d-1');

    expect(api.users.messages.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'd-1',
      format: 'full',
    });
    expect(api.users.drafts.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'd-1',
      format: 'full',
    });
    expect(result.id).toBe('m-draft');
    expect(result.threadId).toBe('t-draft');
  });

  it('Scenario: getMessage also falls back to drafts.get for response-status 404 errors', async () => {
    const api = createMockApi();
    api.users.messages.get.mockRejectedValueOnce({ response: { status: 404 } });
    const client = createClient(api);

    const result = await client.getMessage('d-1');

    expect(api.users.drafts.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'd-1',
      format: 'full',
    });
    expect(result.id).toBe('m-draft');
  });

  it('Scenario: getMessage falls back to drafts.get for Gmail draft ids rejected as invalid message ids', async () => {
    const api = createMockApi();
    api.users.messages.get.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error: {
            message: 'Invalid id value',
          },
        },
      },
    });
    const client = createClient(api);

    const result = await client.getMessage('r1234567890');

    expect(api.users.messages.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'r1234567890',
      format: 'full',
    });
    expect(api.users.drafts.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'r1234567890',
      format: 'full',
    });
    expect(result.id).toBe('m-draft');
    expect(result.threadId).toBe('t-draft');
  });

  it('Scenario: getMessage rethrows non-404 Gmail API errors', async () => {
    const api = createMockApi();
    api.users.messages.get.mockRejectedValueOnce(new Error('boom'));
    const client = createClient(api);

    await expect(client.getMessage('m-1')).rejects.toThrow('boom');
    expect(api.users.drafts.get).not.toHaveBeenCalled();
  });

  it('Scenario: getMessage rethrows unrelated 400 errors instead of treating them as drafts', async () => {
    const api = createMockApi();
    api.users.messages.get.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error: {
            message: 'Bad Request',
          },
        },
      },
    });
    const client = createClient(api);

    await expect(client.getMessage('m-1')).rejects.toMatchObject({
      response: {
        status: 400,
      },
    });
    expect(api.users.drafts.get).not.toHaveBeenCalled();
  });

  it('Scenario: getMessage rejects incomplete Gmail API payloads', async () => {
    const api = createMockApi();
    api.users.messages.get.mockResolvedValueOnce({ data: { id: 'm-1' } });
    const client = createClient(api);

    await expect(client.getMessage('m-1')).rejects.toThrow('incomplete message payload');
  });

  it('Scenario: getAttachment requests Gmail attachment bytes', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.getAttachment('m-1', 'att-1');

    expect(api.users.messages.attachments.get).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'm-1',
      id: 'att-1',
    });
    expect(result).toEqual({
      data: Buffer.from('attachment-bytes').toString('base64url'),
      size: 16,
    });
  });

  it('Scenario: sendMessage routes optional thread ids', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.sendMessage('raw-rfc822', 't-reply');

    expect(api.users.messages.send).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { raw: 'raw-rfc822', threadId: 't-reply' },
    });
    expect(result).toEqual({ id: 'm-sent', threadId: 't-sent' });
  });

  it('Scenario: sendMessage rejects incomplete Gmail send responses', async () => {
    const api = createMockApi();
    api.users.messages.send.mockResolvedValueOnce({ data: { id: 'm-sent' } });
    const client = createClient(api);

    await expect(client.sendMessage('raw-rfc822')).rejects.toThrow('incomplete message summary');
  });

  it('Scenario: createDraft preserves thread association', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.createDraft('raw-rfc822', 't-draft');

    expect(api.users.drafts.create).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { message: { raw: 'raw-rfc822', threadId: 't-draft' } },
    });
    expect(result).toEqual({
      id: 'd-1',
      message: { id: 'm-draft', threadId: 't-draft' },
    });
  });

  it('Scenario: createDraft rejects incomplete draft payloads', async () => {
    const api = createMockApi();
    api.users.drafts.create.mockResolvedValueOnce({ data: { id: 'd-1' } });
    const client = createClient(api);

    await expect(client.createDraft('raw-rfc822')).rejects.toThrow('incomplete draft payload');
  });

  it('Scenario: sendDraft uses Gmail drafts.send', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.sendDraft('d-1');

    expect(api.users.drafts.send).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { id: 'd-1' },
    });
    expect(result).toEqual({
      id: 'd-1',
      message: { id: 'm-sent-draft', threadId: 't-draft' },
    });
  });

  it('Scenario: updateDraft replaces the draft body with thread context intact', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.updateDraft('d-1', 'updated-rfc822', 't-draft');

    expect(api.users.drafts.update).toHaveBeenCalledWith({
      userId: 'me',
      id: 'd-1',
      requestBody: { message: { raw: 'updated-rfc822', threadId: 't-draft' } },
    });
    expect(result).toEqual({
      id: 'd-1',
      message: { id: 'm-updated-draft', threadId: 't-draft' },
    });
  });

  it('Scenario: modifyMessage forwards label mutations', async () => {
    const api = createMockApi();
    const client = createClient(api);

    await client.modifyMessage('m-1', {
      addLabelIds: ['STARRED'],
      removeLabelIds: ['UNREAD'],
    });

    expect(api.users.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'm-1',
      requestBody: {
        addLabelIds: ['STARRED'],
        removeLabelIds: ['UNREAD'],
      },
    });
  });

  it('Scenario: getThread requests full thread payload', async () => {
    const api = createMockApi();
    const client = createClient(api);

    const result = await client.getThread('t-1');

    expect(api.users.threads.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 't-1',
      format: 'full',
    });
    expect(result).toEqual({
      id: 't-1',
      messages: [message('m-1', 't-1')],
    });
  });

  it('Scenario: getThread rejects incomplete thread payloads', async () => {
    const api = createMockApi();
    api.users.threads.get.mockResolvedValueOnce({ data: { id: 't-1' } });
    const client = createClient(api);

    await expect(client.getThread('t-1')).rejects.toThrow('incomplete thread payload');
  });
});
