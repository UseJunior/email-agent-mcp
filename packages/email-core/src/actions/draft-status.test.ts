// Draft status on read results — an unsent draft must never read as sent mail.
import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { listEmailsAction } from './list.js';
import { readEmailAction } from './read.js';
import { searchEmailsAction } from './search.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  ctx = { provider };
});

describe('email-read/Draft Status on Read Results', () => {
  it('Scenario: Search results label a draft', async () => {
    // A draft reply and the delivered message it answers — the draft is the
    // dangerous case: mailbox owner in `from`, `RE:` subject, plausible timestamp.
    provider.addMessage({
      id: 'draft-reply',
      subject: 'RE: Sfumato Fund Docs',
      from: { email: 'steven@usejunior.com', name: 'Steven Obiajulu' },
      receivedAt: '2026-07-25T17:50:18Z',
      isRead: true,
      hasAttachments: false,
      isDraft: true,
    });
    provider.addMessage({
      id: 'delivered-original',
      subject: 'Sfumato Fund Docs',
      from: { email: 'andy@sfumato.holdings' },
      receivedAt: '2026-07-25T17:43:06Z',
      isRead: true,
      hasAttachments: true,
      isDraft: false,
    });

    const result = await searchEmailsAction.run(ctx, { query: 'Sfumato Fund Docs', limit: 25, offset: 0 });

    const draft = result.emails.find(e => e.id === 'draft-reply');
    const delivered = result.emails.find(e => e.id === 'delivered-original');
    expect(draft?.isDraft).toBe(true);
    expect(delivered?.isDraft).toBe(false);
  });

  it('Scenario: Listed rows report draft status explicitly', async () => {
    provider.addMessage({
      id: 'delivered-1',
      subject: 'Quarterly numbers',
      from: { email: 'cfo@corp.com' },
      receivedAt: '2026-07-25T09:00:00Z',
      isRead: false,
      hasAttachments: false,
    });

    const result = await listEmailsAction.run(ctx, { limit: 25, offset: 0, folder: 'inbox' });

    expect(result.emails).toHaveLength(1);
    const row = result.emails[0]!;
    // The key must be PRESENT and false, not omitted: an absent key cannot
    // distinguish "not a draft" from "draft status not reported".
    expect(Object.keys(row)).toContain('isDraft');
    expect(row.isDraft).toBe(false);
  });

  it('Scenario: Reading a draft reports it as unsent', async () => {
    provider.addMessage({
      id: 'draft-1',
      subject: 'RE: Sfumato Fund Docs',
      from: { email: 'steven@usejunior.com' },
      receivedAt: '2026-07-25T17:50:18Z',
      isRead: true,
      hasAttachments: false,
      isDraft: true,
      bodyHtml: '<p>Thanks — reviewing now.</p>',
    });
    provider.addMessage({
      id: 'sent-1',
      subject: 'Sfumato Fund Docs',
      from: { email: 'andy@sfumato.holdings' },
      receivedAt: '2026-07-25T17:43:06Z',
      isRead: true,
      hasAttachments: false,
      bodyHtml: '<p>Docs attached.</p>',
    });

    const draft = await readEmailAction.run(ctx, {
      id: 'draft-1',
      strip_signatures: true,
      strip_quoted_history: false,
    });
    const delivered = await readEmailAction.run(ctx, {
      id: 'sent-1',
      strip_signatures: true,
      strip_quoted_history: false,
    });

    expect(draft.isDraft).toBe(true);
    expect(delivered.isDraft).toBe(false);
  });

  it('Scenario: Provider that does not report draft status defaults to false', async () => {
    // No isDraft on the domain message at all — the field is optional there.
    provider.addMessage({
      id: 'unknown-1',
      subject: 'From a provider with no draft concept',
      from: { email: 'someone@example.com' },
      receivedAt: '2026-07-25T09:00:00Z',
      isRead: false,
      hasAttachments: false,
    });

    const listed = await listEmailsAction.run(ctx, { limit: 25, offset: 0, folder: 'inbox' });
    const searched = await searchEmailsAction.run(ctx, { query: 'provider', limit: 25, offset: 0 });
    const read = await readEmailAction.run(ctx, {
      id: 'unknown-1',
      strip_signatures: true,
      strip_quoted_history: false,
    });

    expect(listed.emails[0]!.isDraft).toBe(false);
    expect(searched.emails[0]!.isDraft).toBe(false);
    expect(read.isDraft).toBe(false);
  });

  it('states the draft consequence in the tool descriptions an agent reads', () => {
    // The field only helps if the agent knows what it means. Assert the
    // descriptions name the field and deny that such a message was sent.
    for (const action of [listEmailsAction, searchEmailsAction, readEmailAction]) {
      expect(action.description).toContain('isDraft');
      expect(action.description).toMatch(/not been sent/i);
    }
  });
});
