import { describe, it, expect, vi } from 'vitest';
import { GmailEmailProvider, type GmailApiClient } from './email-gmail-provider.js';

function createMockGmailClient(overrides: Partial<GmailApiClient> = {}): GmailApiClient {
  return {
    listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getMessage: vi.fn().mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'From', value: '"Alice" <alice@corp.com>' },
          { name: 'To', value: 'bob@corp.com' },
          { name: 'Subject', value: 'Test Email' },
          { name: 'Date', value: '2024-03-15T10:00:00Z' },
        ],
        body: { data: Buffer.from('Hello world').toString('base64url') },
      },
      internalDate: String(new Date('2024-03-15T10:00:00Z').getTime()),
    }),
    sendMessage: vi.fn().mockResolvedValue({ id: 'sent-1', threadId: 'thread-1' }),
    modifyMessage: vi.fn().mockResolvedValue(undefined),
    getThread: vi.fn().mockResolvedValue({ id: 'thread-1', messages: [] }),
    createDraft: vi.fn().mockResolvedValue({ id: 'draft-abc', message: { id: 'msg-draft', threadId: 'thread-draft' } }),
    sendDraft: vi.fn().mockResolvedValue({ id: 'draft-abc', message: { id: 'sent-draft-msg', threadId: 'thread-draft' } }),
    ...overrides,
  };
}

describe('provider-gmail/Message Mapping', () => {
  it('Scenario: Gmail message to EmailMessage', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const msg = await provider.getMessage('msg-1');

    expect(msg.id).toBe('msg-1');
    expect(msg.threadId).toBe('thread-1');
    expect(msg.subject).toBe('Test Email');
    expect(msg.from.email).toBe('alice@corp.com');
    expect(msg.from.name).toBe('Alice');
    expect(msg.labels).toContain('INBOX');
    expect(msg.isRead).toBe(false); // Has UNREAD label
  });
});

describe('provider-gmail/Label Mapping', () => {
  it('Scenario: Label as folder', async () => {
    const client = createMockGmailClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 'spam-1', threadId: 'thread-spam' }],
      }),
      getMessage: vi.fn().mockResolvedValue({
        id: 'spam-1',
        threadId: 'thread-spam',
        labelIds: ['SPAM'],
        payload: {
          headers: [
            { name: 'From', value: 'spammer@evil.com' },
            { name: 'Subject', value: 'Buy now!' },
            { name: 'Date', value: '2024-03-15T10:00:00Z' },
          ],
        },
        internalDate: String(Date.now()),
      }),
    });
    const provider = new GmailEmailProvider(client);

    // WHEN list_emails is called with {folder: "junk"}
    await provider.listMessages({ folder: 'junk' });

    // THEN the system queries messages with the SPAM label
    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ labelIds: ['SPAM'] }),
    );
  });
});

describe('provider-gmail/Draft Operations', () => {
  it('Scenario: createDraft sends raw message to Gmail API', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const result = await provider.createDraft({
      to: [{ email: 'bob@corp.com', name: 'Bob' }],
      subject: 'Draft subject',
      body: '<p>Draft body</p>',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-abc');
    expect(client.createDraft).toHaveBeenCalledWith(expect.any(String));
  });

  it('Scenario: sendDraft calls Gmail API with draft ID', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const result = await provider.sendDraft('draft-abc');

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('sent-draft-msg');
    expect(client.sendDraft).toHaveBeenCalledWith('draft-abc');
  });
});

describe('provider-gmail/NemoClaw Compatibility', () => {
  it('Scenario: NemoClaw egress', () => {
    const domains = GmailEmailProvider.egressDomains;
    expect(domains).toContain('gmail.googleapis.com');
    expect(domains).toContain('oauth2.googleapis.com');
    expect(domains).toContain('pubsub.googleapis.com');
  });
});

describe('provider-gmail/Body Content Type', () => {
  function decodeRaw(base64url: string): string {
    return Buffer.from(base64url, 'base64url').toString('utf-8');
  }

  it('Scenario: bodyHtml set → Content-Type: text/html', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'HTML body',
      body: '### Hi',
      bodyHtml: '<h3>Hi</h3>',
    });

    const raw = decodeRaw((client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw).toContain('<h3>Hi</h3>');
  });

  it('Scenario: only body set → Content-Type: text/plain', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'Plain body',
      body: 'line one\nline two',
    });

    const raw = decodeRaw((client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    // Body newlines are preserved verbatim — outer CRLF is from the mime header join.
    expect(raw).toContain('line one\nline two');
  });
});
