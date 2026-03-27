import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { listEmailsAction } from './list.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  ctx = { provider };
});

describe('email-read/List Emails', () => {
  it('Scenario: List unread emails from inbox', async () => {
    // Setup: 5 unread + 3 read messages in inbox
    for (let i = 0; i < 5; i++) {
      provider.addMessage({ id: `unread-${i}`, subject: `Unread ${i}`, isRead: false, folder: 'inbox' });
    }
    for (let i = 0; i < 3; i++) {
      provider.addMessage({ id: `read-${i}`, subject: `Read ${i}`, isRead: true, folder: 'inbox' });
    }

    const result = await listEmailsAction.run(ctx, { unread: true, limit: 10, folder: 'inbox' });

    expect(result.emails).toHaveLength(5);
    for (const email of result.emails) {
      expect(email.isRead).toBe(false);
      // Each email includes required fields
      expect(email).toHaveProperty('id');
      expect(email).toHaveProperty('subject');
      expect(email).toHaveProperty('from');
      expect(email).toHaveProperty('receivedAt');
      expect(email).toHaveProperty('isRead');
      expect(email).toHaveProperty('hasAttachments');
    }
  });

  it('Scenario: List from specific mailbox', async () => {
    provider.addMessage({ id: 'sent-1', subject: 'Sent email', folder: 'sent' });
    provider.addMessage({ id: 'inbox-1', subject: 'Inbox email', folder: 'inbox' });

    const result = await listEmailsAction.run(ctx, { mailbox: 'work', folder: 'sent' });
    expect(result.emails).toHaveLength(1);
    expect(result.emails[0]!.subject).toBe('Sent email');
  });

  it('Scenario: Default limit applied', async () => {
    // Add 30 messages
    for (let i = 0; i < 30; i++) {
      provider.addMessage({ id: `msg-${i}`, subject: `Message ${i}`, folder: 'inbox' });
    }

    // No limit parameter → default 25
    const result = await listEmailsAction.run(ctx, { folder: 'inbox' });
    expect(result.emails).toHaveLength(25);
  });
});

describe('email-read/Folder Routing', () => {
  it('Scenario: Include junk folder', async () => {
    provider.addMessage({ id: 'junk-1', subject: 'Spam offer', folder: 'junk' });
    provider.addMessage({ id: 'inbox-1', subject: 'Real email', folder: 'inbox' });

    const result = await listEmailsAction.run(ctx, { folder: 'junk' });
    expect(result.emails).toHaveLength(1);
    expect(result.emails[0]!.subject).toBe('Spam offer');
  });
});
