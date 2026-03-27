import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { searchEmailsAction } from './search.js';
import type { ActionContext, MailboxEntry } from './registry.js';

describe('email-read/Search Emails', () => {
  it('Scenario: Search across all mailboxes', async () => {
    // Set up two mailbox providers
    const workProvider = new MockEmailProvider();
    workProvider.addMessage({
      id: 'work-1',
      subject: 'Contract review needed',
      from: { email: 'alice@corp.com' },
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: false,
      hasAttachments: false,
    });

    const personalProvider = new MockEmailProvider();
    personalProvider.addMessage({
      id: 'personal-1',
      subject: 'Contract review for home purchase',
      from: { email: 'realtor@homes.com' },
      receivedAt: '2024-03-15T11:00:00Z',
      isRead: true,
      hasAttachments: false,
    });

    const allMailboxes: MailboxEntry[] = [
      { name: 'work', provider: workProvider, providerType: 'microsoft', isDefault: true, status: 'connected' },
      { name: 'personal', provider: personalProvider, providerType: 'gmail', isDefault: false, status: 'connected' },
    ];

    const ctx: ActionContext = {
      provider: workProvider,
      allMailboxes,
    };

    // WHEN search_emails is called with mailbox: null (search across all)
    const result = await searchEmailsAction.run(ctx, { query: 'contract review', mailbox: null });

    // THEN returns matching emails with originating mailbox name
    expect(result.emails.length).toBeGreaterThanOrEqual(2);
    const mailboxNames = result.emails.map(e => e.mailbox);
    expect(mailboxNames).toContain('work');
    expect(mailboxNames).toContain('personal');
  });
});
