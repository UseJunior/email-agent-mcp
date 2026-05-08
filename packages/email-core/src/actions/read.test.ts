import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { readEmailAction } from './read.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  ctx = { provider };
});

const QUOTE_MARKER = '[...prior thread truncated]';

describe('email-read/Read Email', () => {
  it('Scenario: Read email with body and metadata', async () => {
    provider.addMessage({
      id: 'msg123',
      subject: 'Contract Review',
      from: { email: 'alice@corp.com', name: 'Alice Smith' },
      to: [{ email: 'bob@corp.com', name: 'Bob Jones' }],
      receivedAt: '2024-03-15T10:30:00Z',
      isRead: false,
      hasAttachments: true,
      bodyHtml: '<p>Please review the attached contract.</p>',
      attachments: [
        { id: 'att1', filename: 'contract.pdf', mimeType: 'application/pdf', size: 245000, isInline: false },
      ],
    });

    const result = await readEmailAction.run(ctx, { id: 'msg123' });

    expect(result.id).toBe('msg123');
    expect(result.subject).toBe('Contract Review');
    expect(result.from).toContain('Alice Smith');
    expect(result.from).toContain('alice@corp.com');
    expect(result.to).toContain('Bob Jones <bob@corp.com>');
    expect(result.receivedAt).toBe('2024-03-15T10:30:00Z');
    expect(result.body).toContain('Please review the attached contract');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]!.filename).toBe('contract.pdf');
  });

  it('Scenario: strip_quoted_history omitted preserves full thread', async () => {
    provider.addMessage({
      id: 'msg-thread',
      body: [
        'Sounds good — see you Wednesday.',
        '',
        'On Tue, Mar 12, 2024 at 4:00 PM Alice <alice@corp.com> wrote:',
        '> Can we sync at 10am?',
        '> Talk soon.',
      ].join('\n'),
    });

    const result = await readEmailAction.run(ctx, { id: 'msg-thread' });

    expect(result.body).toContain('Sounds good');
    expect(result.body).toContain('Can we sync at 10am?');
    expect(result.body).not.toContain(QUOTE_MARKER);
  });

  it('Scenario: strip_quoted_history true removes terminal Gmail-style chain', async () => {
    provider.addMessage({
      id: 'msg-thread',
      body: [
        'Sounds good — see you Wednesday.',
        '',
        'On Tue, Mar 12, 2024 at 4:00 PM Alice <alice@corp.com> wrote:',
        '> Can we sync at 10am?',
        '> Talk soon.',
      ].join('\n'),
    });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-thread',
      strip_quoted_history: true,
    });

    expect(result.body).toContain('Sounds good');
    expect(result.body).toContain(QUOTE_MARKER);
    expect(result.body).not.toContain('Can we sync at 10am?');
  });

  it('Scenario: strip_quoted_history true on Gmail-style HTML body', async () => {
    provider.addMessage({
      id: 'msg-html',
      bodyHtml: [
        '<p>Confirmed — 10am works.</p>',
        '<div class="gmail_quote">',
        '<div>On Wed, Mar 13, 2024 at 9:30 AM Alice &lt;alice@corp.com&gt; wrote:</div>',
        '<blockquote>Can we move it to 10am?</blockquote>',
        '</div>',
      ].join(''),
    });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-html',
      strip_quoted_history: true,
    });

    expect(result.body).toContain('Confirmed');
    expect(result.body).toContain(QUOTE_MARKER);
    expect(result.body).not.toContain('Can we move it to 10am?');
  });

  it('Scenario: both flags applied — RFC signature delimiter cuts marker too (documents real behavior)', async () => {
    // When the latest reply uses the RFC 3676 "-- \n" signature delimiter, signature
    // stripping unconditionally cuts everything after that delimiter. Quote stripping
    // runs first and inserts the marker, but the marker sits past the delimiter, so
    // the signature pass removes it. The end result is a clean reply, which is the
    // correct outcome — we just don't expect the marker to survive in this shape.
    const quotedTail = Array.from({ length: 40 }, (_, i) => `> historical line ${i + 1}`).join('\n');
    provider.addMessage({
      id: 'msg-both-rfc',
      body: [
        'Approved.',
        '',
        '-- ',
        'Bob Jones',
        'Senior Partner',
        '',
        'On Wed, Mar 13, 2024 at 9:30 AM Alice <alice@corp.com> wrote:',
        quotedTail,
      ].join('\n'),
    });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-both-rfc',
      strip_quoted_history: true,
      strip_signatures: true,
    });

    expect(result.body).toContain('Approved.');
    expect(result.body).not.toContain('Bob Jones');
    expect(result.body).not.toContain('historical line 1');
  });

  it('Scenario: attachment shape includes contentId when provider returns it', async () => {
    provider.addMessage({
      id: 'msg-inline',
      bodyHtml: '<p>see image</p>',
      attachments: [
        {
          id: 'inline-1',
          filename: 'logo.png',
          mimeType: 'image/png',
          size: 1024,
          isInline: true,
          contentId: 'cid:logo@example.com',
        },
      ],
    });

    const result = await readEmailAction.run(ctx, { id: 'msg-inline' });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]!.contentId).toBe('cid:logo@example.com');
  });
});
