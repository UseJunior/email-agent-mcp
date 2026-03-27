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

describe('provider-gmail/NemoClaw Compatibility', () => {
  it('Scenario: NemoClaw egress', () => {
    const domains = GmailEmailProvider.egressDomains;
    expect(domains).toContain('gmail.googleapis.com');
    expect(domains).toContain('oauth2.googleapis.com');
    expect(domains).toContain('pubsub.googleapis.com');
  });
});
