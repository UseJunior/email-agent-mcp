import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { readEmailAction, READ_HTML_BODY_LIMIT } from './read.js';
import { renderEmailBody } from '../content/body-renderer.js';
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

  it('Scenario: Default behavior is unchanged', async () => {
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

  it('Scenario: Strip quoted history when flag is true', async () => {
    // Also verifies: strip_quoted_history true removes a terminal
    // Gmail-style "On … wrote:" chain.
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

// A body carrying hand-applied inline styling — the shape that motivated issue
// #156. Red strikethrough and blue underline mark proposed contract edits; the
// markdown conversion cannot carry any of it, so a read → edit → write round
// trip through markdown flattens the document.
const STYLED_BODY_HTML = [
  '<div style="color: #000000;">',
  '<p>The term is ',
  '<span style="color:#FF0000;text-decoration:line-through">thirty (30) days</span> ',
  '<span style="color:#0000FF;text-decoration:underline">sixty (60) days</span>',
  ' from the Effective Date.</p>',
  '<p>Please confirm <mark style="background-color:#FFFF00">the fee schedule</mark> is right.</p>',
  '<p><u>Signature blocks</u> are attached separately.</p>',
  '</div>',
].join('');

// A body that makes the markdown-path transforms actually fire: HTML styling to
// flatten, an attachment to summarize, and a terminal quoted-history block that
// the default (flag off) must leave in place. A "default unchanged" assertion
// over a fixture that exercises none of these proves nothing.
const FULL_TRANSFORM_HTML = [
  STYLED_BODY_HTML,
  '<div class="gmail_quote">',
  '<div>On Wed, Mar 13, 2024 at 9:30 AM Alice &lt;alice@corp.com&gt; wrote:</div>',
  '<blockquote>Can we move it to 10am?</blockquote>',
  '</div>',
].join('');

const FULL_TRANSFORM_ATTACHMENTS = [
  { id: 'att1', filename: 'contract.pdf', mimeType: 'application/pdf', size: 245000, isInline: false },
];

describe('email-read/Raw HTML Body Output', () => {
  it('Scenario: Omitting format returns markdown exactly as before', async () => {
    provider.addMessage({ id: 'msg-styled', bodyHtml: STYLED_BODY_HTML });

    const result = await readEmailAction.run(ctx, { id: 'msg-styled' });

    expect(result.bodyFormat).toBe('markdown');
    expect(result.bodyTruncated).toBeUndefined();
    // Prose survives; every styling carrier is gone. This is the failure the
    // html format exists to avoid, asserted here so the default stays honest.
    expect(result.body).toContain('sixty (60) days');
    expect(result.body).not.toContain('color:#FF0000');
    expect(result.body).not.toContain('color:#0000FF');
    expect(result.body).not.toContain('text-decoration:underline');
    expect(result.body).not.toContain('background-color:#FFFF00');
    expect(result.body).not.toContain('<span');
    expect(result.body).not.toContain('<u>');
  });

  it('Scenario: The markdown default resolves and behaves as it did before format existed', async () => {
    // Two distinct claims, both load-bearing, and neither provable by comparing
    // the new action against itself with hand-passed arguments:
    //
    // 1. `format` resolves to 'markdown' through the schema's own default, so a
    //    caller that omits it lands on the markdown branch. Asserted by parsing an
    //    input that omits it rather than by passing 'markdown' in by hand.
    // 2. The markdown branch still produces the exact bytes it produced on main.
    //    Asserted against a literal expected string, not against another call —
    //    a golden value cannot drift in sympathy with the implementation.
    provider.addMessage({
      id: 'msg-full',
      bodyHtml: FULL_TRANSFORM_HTML,
      attachments: FULL_TRANSFORM_ATTACHMENTS,
    });
    // Separate fixture for the signature pass: an RFC 3676 "-- " delimiter in a
    // plain-text body, which is where strip_signatures actually fires.
    provider.addMessage({
      id: 'msg-sig',
      body: 'Approved as written.\n\n-- \nBob Jones\nSenior Partner',
    });

    const parsed = readEmailAction.input.parse({ id: 'msg-full' });
    expect(parsed.format).toBe('markdown');
    // The other two defaults are unchanged by this work; pinned here because the
    // golden bodies below depend on them.
    expect(parsed.strip_signatures).toBe(true);
    expect(parsed.strip_quoted_history).toBe(false);

    const result = await readEmailAction.run(ctx, parsed);

    // Golden output of the pre-`format` markdown pipeline: html → markdown with
    // every styling carrier flattened, quoted history left in place (flag off),
    // and the attachment summary appended.
    expect(result.body).toBe(
      'The term is thirty (30) days sixty (60) days from the Effective Date.'
      + 'Please confirm the fee schedule is right.'
      + 'Signature blocks are attached separately.'
      + 'On Wed, Mar 13, 2024 at 9:30 AM Alice <alice@corp.com> wrote:\n\n'
      + '> Can we move it to 10am?\n\n'
      + 'Attachments: contract.pdf (239KB)',
    );
    expect(result.bodyFormat).toBe('markdown');
    expect(result.bodyTruncated).toBeUndefined();

    // Golden output of the signature pass, on the fixture that triggers it.
    const sig = await readEmailAction.run(ctx, readEmailAction.input.parse({ id: 'msg-sig' }));
    expect(sig.body).toBe('Approved as written.');

    // Direct run() with `format` absent — how every existing caller in this repo
    // invokes the action, bypassing the schema — must land on the same branch.
    const direct = await readEmailAction.run(ctx, {
      id: 'msg-full',
      strip_signatures: true,
      strip_quoted_history: false,
    });
    expect(direct.body).toBe(result.body);
    expect(direct.bodyFormat).toBe('markdown');
  });

  it("Scenario: format 'html' returns styling the markdown conversion destroys", async () => {
    provider.addMessage({ id: 'msg-styled', bodyHtml: STYLED_BODY_HTML });

    const result = await readEmailAction.run(ctx, { id: 'msg-styled', format: 'html' });

    expect(result.bodyFormat).toBe('html');
    // Verbatim — this is what makes a round trip possible at all.
    expect(result.body).toBe(STYLED_BODY_HTML);
    // Named individually so a regression says which carrier was lost.
    expect(result.body).toContain('color:#FF0000');
    expect(result.body).toContain('text-decoration:line-through');
    expect(result.body).toContain('color:#0000FF');
    expect(result.body).toContain('text-decoration:underline');
    expect(result.body).toContain('background-color:#FFFF00');
    expect(result.body).toContain('<u>Signature blocks</u>');
    expect(result.bodyTruncated).toBeUndefined();
  });

  it("Scenario: format 'html' skips the markdown-shaped text transforms", async () => {
    // stripQuotedHistory and stripSignature operate on markdown-shaped text and
    // rewrite the string. Running either over raw HTML would break the byte
    // fidelity the html format exists to provide, so both are skipped.
    const html = [
      '<div><p>Confirmed — 10am works.</p>',
      '<p>-- <br>Bob Jones<br>Senior Partner</p>',
      '<div class="gmail_quote">',
      '<div>On Wed, Mar 13, 2024 at 9:30 AM Alice &lt;alice@corp.com&gt; wrote:</div>',
      '<blockquote>Can we move it to 10am?</blockquote>',
      '</div></div>',
    ].join('');
    provider.addMessage({ id: 'msg-html-verbatim', bodyHtml: html });

    const result = await readEmailAction.run(ctx, {
      id: 'msg-html-verbatim',
      format: 'html',
      strip_quoted_history: true,
      strip_signatures: true,
    });

    expect(result.body).toBe(html);
    expect(result.body).not.toContain(QUOTE_MARKER);
    expect(result.body).toContain('Senior Partner');
    expect(result.body).toContain('Can we move it to 10am?');
  });

  it("Scenario: format 'html' does not append the attachment summary", async () => {
    // The markdown path appends an "Attachments: …" line. Appending prose to raw
    // HTML would be written straight back into the message body on a round trip.
    provider.addMessage({
      id: 'msg-html-att',
      bodyHtml: '<p style="color:#FF0000">See attached.</p>',
      attachments: [
        { id: 'att1', filename: 'contract.pdf', mimeType: 'application/pdf', size: 245000, isInline: false },
      ],
    });

    const markdown = await readEmailAction.run(ctx, { id: 'msg-html-att' });
    const raw = await readEmailAction.run(ctx, { id: 'msg-html-att', format: 'html' });

    expect(markdown.body).toContain('Attachments: contract.pdf');
    expect(raw.body).toBe('<p style="color:#FF0000">See attached.</p>');
    // Still reported structurally, so nothing is actually lost.
    expect(raw.attachments).toHaveLength(1);
    expect(raw.attachments![0]!.filename).toBe('contract.pdf');
  });

  it('Scenario: Oversized raw HTML body is flagged as truncated', async () => {
    // Raw HTML is many times larger than its markdown reduction, so the cap can
    // realistically fire here where it never does on the markdown path.
    const filler = '<p style="color:#FF0000">padding padding padding</p>'.repeat(8000);
    const bodyHtml = `<div>${filler}</div>`;
    expect(Buffer.byteLength(bodyHtml, 'utf-8')).toBeGreaterThan(READ_HTML_BODY_LIMIT);
    provider.addMessage({ id: 'msg-huge', bodyHtml });

    const result = await readEmailAction.run(ctx, { id: 'msg-huge', format: 'html' });

    expect(result.bodyTruncated).toBe(true);
    expect(result.bodyFormat).toBe('html');
    expect(Buffer.byteLength(result.body, 'utf-8')).toBeLessThanOrEqual(READ_HTML_BODY_LIMIT);
    expect(bodyHtml.startsWith(result.body)).toBe(true);
  });

  it('Scenario: Raw HTML body under the budget is not flagged as truncated', async () => {
    // The flag is a warning, not a status field: it must be absent in the common
    // case, and a caller must be able to treat its absence as "safe to write back".
    const bodyHtml = `<div>${'<p style="color:#0000FF">short</p>'.repeat(10)}</div>`;
    expect(Buffer.byteLength(bodyHtml, 'utf-8')).toBeLessThan(READ_HTML_BODY_LIMIT);
    provider.addMessage({ id: 'msg-small', bodyHtml });

    const result = await readEmailAction.run(ctx, { id: 'msg-small', format: 'html' });

    expect(result.body).toBe(bodyHtml);
    expect(result.bodyTruncated).toBeUndefined();
  });

  it('Scenario: Oversized plain-text fallback is flagged as truncated', async () => {
    // The cap covers whatever the html branch returns, including the text
    // fallback: it is still a `format: "html"` response headed for the same MCP
    // budget, and an unbounded one truncated by the transport would arrive
    // mangled with no flag on it. The markdown path stays uncapped.
    const body = 'x'.repeat(READ_HTML_BODY_LIMIT + 1);
    provider.addMessage({ id: 'msg-huge-text', body });

    const raw = await readEmailAction.run(ctx, { id: 'msg-huge-text', format: 'html' });
    expect(raw.bodyFormat).toBe('text');
    expect(raw.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(raw.body, 'utf-8')).toBeLessThanOrEqual(READ_HTML_BODY_LIMIT);

    // The default markdown path is unbounded, exactly as before this change.
    const markdown = await readEmailAction.run(ctx, { id: 'msg-huge-text' });
    expect(markdown.body).toBe(body);
    expect(markdown.bodyTruncated).toBeUndefined();
  });

  it('Scenario: Raw HTML round-trips unchanged through the compose renderer', async () => {
    // The read side is only half the round trip. renderEmailBody defaults
    // forceBlack to true even for format 'html', which wraps the body and nests
    // another wrapper on every cycle — so the tool description tells the agent to
    // pass force_black: false. Both halves are pinned here: with the flag off the
    // bytes survive three cycles untouched; with it on, they demonstrably do not.
    provider.addMessage({ id: 'msg-roundtrip', bodyHtml: STYLED_BODY_HTML });

    let current = (await readEmailAction.run(ctx, { id: 'msg-roundtrip', format: 'html' })).body;
    expect(current).toBe(STYLED_BODY_HTML);

    for (let cycle = 0; cycle < 3; cycle++) {
      const rendered = renderEmailBody(current, { format: 'html', forceBlack: false });
      expect(rendered.bodyHtml).toBe(STYLED_BODY_HTML);
      current = rendered.bodyHtml!;
    }

    // Why the description has to say force_black: false — left on, each cycle adds
    // a wrapper, so a body revised fifteen times carries fifteen nested divs.
    const wrapped = renderEmailBody(STYLED_BODY_HTML, { format: 'html' }).bodyHtml!;
    expect(wrapped).not.toBe(STYLED_BODY_HTML);
    expect(wrapped.startsWith('<div style="color: #000000;">')).toBe(true);
    expect(readEmailAction.description).toContain('force_black: false');
  });

  it("Scenario: format 'html' on a message with no HTML part reports text", async () => {
    // Writing a plain-text body back as HTML would mangle it, so this case must
    // be distinguishable from a real HTML body rather than silently looking like one.
    provider.addMessage({ id: 'msg-text-only', body: 'Plain text only.\n\nNo HTML part here.' });

    const result = await readEmailAction.run(ctx, { id: 'msg-text-only', format: 'html' });

    expect(result.bodyFormat).toBe('text');
    expect(result.body).toBe('Plain text only.\n\nNo HTML part here.');
  });

  it('Scenario: Every read reports what body it returned', async () => {
    // Always present, never omitted — the recipient-topology precedent from
    // issue #102. A caller about to write the body back must not have to guess.
    provider.addMessage({ id: 'msg-shape', bodyHtml: '<p>hello</p>' });

    const markdown = await readEmailAction.run(ctx, { id: 'msg-shape' });
    const raw = await readEmailAction.run(ctx, { id: 'msg-shape', format: 'html' });

    expect('bodyFormat' in markdown).toBe(true);
    expect('bodyFormat' in raw).toBe(true);
    expect(markdown.bodyFormat).toBe('markdown');
    expect(raw.bodyFormat).toBe('html');
  });

  it('tells the agent in the tool description when to reach for raw HTML', () => {
    // The parameter only helps if the agent knows the markdown path destroys
    // styling and that raw HTML costs tokens.
    expect(readEmailAction.description).toContain("format to 'html'");
    expect(readEmailAction.description).toMatch(/bodyFormat/);
    expect(readEmailAction.description).toMatch(/token/i);
  });
});
