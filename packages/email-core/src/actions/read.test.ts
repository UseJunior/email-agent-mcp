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

  it('Scenario: Cc and Bcc recipients are always reported', async () => {
    provider.addMessage({
      id: 'msg-cc',
      subject: 'Re: follow-up from coffee',
      from: { email: 'alice@corp.com', name: 'Alice Smith' },
      to: [
        { email: 'bob@corp.com', name: 'Bob Jones' },
        { email: 'nandita@corp.com', name: 'Nandita Sethi' },
      ],
      cc: [
        { email: 'nadim@corp.com', name: 'Nadim Cheaib' },
        { email: 'tiffany@corp.com', name: 'Tiffany Loer' },
      ],
      bcc: [{ email: 'audit@corp.com' }],
      body: 'See you then.',
    });

    const result = await readEmailAction.run(ctx, { id: 'msg-cc' });

    expect(result.to).toEqual(['Bob Jones <bob@corp.com>', 'Nandita Sethi <nandita@corp.com>']);
    expect(result.cc).toEqual(['Nadim Cheaib <nadim@corp.com>', 'Tiffany Loer <tiffany@corp.com>']);
    expect(result.bcc).toEqual(['audit@corp.com']);
  });

  it('Scenario: cc and bcc are explicit empty arrays when absent, never dropped (issue #102)', async () => {
    // Absence of Cc must be unambiguous: an empty array, not a missing key. A
    // missing key silently reads as "no Cc" and can drop stakeholders on a reply.
    provider.addMessage({
      id: 'msg-nocc',
      from: { email: 'alice@corp.com', name: 'Alice Smith' },
      to: [{ email: 'bob@corp.com', name: 'Bob Jones' }],
      body: 'One-to-one note.',
    });

    const result = await readEmailAction.run(ctx, { id: 'msg-nocc' });

    expect(result.cc).toEqual([]);
    expect(result.bcc).toEqual([]);
    expect('cc' in result).toBe(true);
    expect('bcc' in result).toBe(true);
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

  it('Scenario: strip_quoted_history true on Outlook-style HTML body with header cluster', async () => {
    // Real Outlook web/365 reply HTML uses `<div>From:</div>` blocks for the header
    // cluster. This test exercises the path from raw HTML through transformEmailContent
    // to the detector — i.e. it covers normalization, not just pre-rendered markdown.
    provider.addMessage({
      id: 'msg-outlook-html',
      bodyHtml: [
        '<p>Confirmed — 10am tomorrow.</p>',
        '<div>',
        '<div>From: Alice &lt;alice@corp.com&gt;</div>',
        '<div>Sent: Wednesday, March 13, 2024 9:30 AM</div>',
        '<div>To: Bob &lt;bob@corp.com&gt;</div>',
        '<div>Subject: RE: Contract review</div>',
        '</div>',
        '<p>Can we move the call to 10am?</p>',
      ].join(''),
    });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-outlook-html',
      strip_quoted_history: true,
    });

    expect(result.body).toContain('Confirmed');
    expect(result.body).toContain(QUOTE_MARKER);
    expect(result.body).not.toContain('Can we move the call to 10am?');
    expect(result.body).not.toContain('alice@corp.com');
  });

  it('Scenario: strip_quoted_history true on bolded-Outlook HTML body (Outlook-365 / OWA shape)', async () => {
    // Outlook-on-the-web wraps the field labels in `<strong>` / `<b>`. node-html-markdown
    // emits these as `**From:**` (or sometimes `**From**:`) — the detector must handle
    // both, end-to-end from HTML.
    provider.addMessage({
      id: 'msg-outlook-bold-html',
      bodyHtml: [
        '<p>Yes.</p>',
        '<div>',
        '<div><strong>From:</strong> Alice &lt;alice@corp.com&gt;</div>',
        '<div><strong>Sent:</strong> Wednesday, May 6, 2026 11:38 AM</div>',
        '<div><strong>To:</strong> Bob &lt;bob@corp.com&gt;</div>',
        '<div><strong>Subject:</strong> RE: Symposium logistics</div>',
        '</div>',
        '<p>Original body — could we move it to 10am?</p>',
      ].join(''),
    });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-outlook-bold-html',
      strip_quoted_history: true,
    });

    expect(result.body).toContain('Yes.');
    expect(result.body).toContain(QUOTE_MARKER);
    expect(result.body).not.toContain('Original body — could we move it to 10am?');
    expect(result.body).not.toContain('alice@corp.com');
  });

  it('Scenario: strip_quoted_history true preserves user prose after an inline Gmail quote (HTML input)', async () => {
    // Regression for the terminal-validation fix: an inline `On … wrote:` quote
    // followed by additional user-authored prose must NOT collapse the user's
    // continuation into the marker.
    provider.addMessage({
      id: 'msg-inline-html',
      bodyHtml: [
        '<p>Including for context:</p>',
        '<div class="gmail_quote">',
        '<div>On Wed, Mar 13, 2024 at 9:30 AM Alice &lt;alice@corp.com&gt; wrote:</div>',
        '<blockquote>Want to push standup to 10am?</blockquote>',
        '</div>',
        '<p>My take: 10am is fine but conflicts with Bob — let me check.</p>',
      ].join(''),
    });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-inline-html',
      strip_quoted_history: true,
    });

    expect(result.body).toContain('Including for context');
    expect(result.body).toContain('My take');
    expect(result.body).toContain('let me check');
    expect(result.body).not.toContain(QUOTE_MARKER);
  });

  it('Scenario: strip_quoted_history true with mobile (non-RFC) signature above marker', async () => {
    // Many mobile clients use a non-RFC signature like "Sent from my iPhone" without
    // the "-- " delimiter. The signature heuristic strips by length-percentage on this
    // shape, which can run after quote stripping has inserted the marker. Confirm the
    // marker survives.
    provider.addMessage({
      id: 'msg-mobile-sig',
      body: [
        'Approved.',
        '',
        'Sent from my iPhone',
        '',
        'On Wed, Mar 13, 2024 at 9:30 AM Alice <alice@corp.com> wrote:',
        '> earlier draft of the contract',
      ].join('\n'),
    });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-mobile-sig',
      strip_quoted_history: true,
      strip_signatures: true,
    });

    expect(result.body).toContain('Approved.');
    expect(result.body).toContain(QUOTE_MARKER);
    expect(result.body).not.toContain('earlier draft');
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
