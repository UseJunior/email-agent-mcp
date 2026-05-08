import { describe, it, expect } from 'vitest';
import { stripQuotedHistory } from './quotes.js';

const MARKER = '[...prior thread truncated]';

describe('content-engine/Quoted-History Stripping', () => {
  it('Scenario: Strip Gmail "On … wrote:" preamble with quoted reply', () => {
    const body = [
      "Thanks, that works for me.",
      "",
      "On Wed, Mar 13, 2024 at 9:30 AM Alice <alice@corp.com> wrote:",
      "> Can we move the call to 10am?",
      "> Let me know if that works.",
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Thanks, that works for me.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Can we move the call');
    expect(result).not.toContain('On Wed, Mar 13');
  });

  it('Scenario: Strip Outlook From/Sent/To/Subject header cluster', () => {
    const body = [
      "Confirmed — 10am tomorrow.",
      "",
      "From: Alice <alice@corp.com>",
      "Sent: Wednesday, March 13, 2024 9:30 AM",
      "To: Bob <bob@corp.com>",
      "Subject: RE: Contract review",
      "",
      "Can we move the call to 10am?",
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Confirmed — 10am tomorrow.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('From: Alice');
    expect(result).not.toContain('Can we move the call');
  });

  it('Scenario: Strip 11-level nested terminal `>` quote block', () => {
    const deepLines: string[] = [];
    for (let depth = 1; depth <= 11; depth++) {
      deepLines.push(`${'>'.repeat(depth)} reply at depth ${depth}`);
    }
    const body = ['Short reply.', '', ...deepLines].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Short reply.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('reply at depth 11');
    expect(result).not.toContain('reply at depth 1');
  });

  it('Scenario: Idempotent — calling twice yields same result', () => {
    const body = [
      "Got it.",
      "",
      "On Wed, Mar 13 Alice wrote:",
      "> hello",
    ].join('\n');

    const once = stripQuotedHistory(body);
    const twice = stripQuotedHistory(once);
    expect(twice).toBe(once);
  });

  it('Scenario: Inline markdown blockquote followed by user text is preserved', () => {
    const body = [
      "Hey team,",
      "",
      "> Quick reminder from the offsite notes:",
      "",
      "We agreed to ship on Friday. Anything blocking?",
    ].join('\n');

    const result = stripQuotedHistory(body);
    expect(result).toBe(body);
    expect(result).not.toContain(MARKER);
  });

  it('Scenario: "On X, I wrote:" line not followed by quotes is preserved', () => {
    const body = [
      'On vacation last week, I wrote:',
      'a few notes that I want to share with the team about the new process.',
      'No quotes follow.',
    ].join('\n');

    const result = stripQuotedHistory(body);
    expect(result).toBe(body);
  });

  it('Scenario: Single bare "From:" line in user content is preserved', () => {
    const body = [
      'Update on the proposal:',
      '',
      'From: the legal team, we got pushback on clause 4.',
      'Not a real header — just narrative.',
    ].join('\n');

    const result = stripQuotedHistory(body);
    expect(result).toBe(body);
  });

  it('Scenario: Attachments summary is preserved when quoted block is between body and summary', () => {
    const body = [
      'See the attached.',
      '',
      'On Wed Alice wrote:',
      '> earlier draft',
      '',
      'Attachments: contract.pdf (245KB)',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('See the attached.');
    expect(result).toContain(MARKER);
    expect(result).toContain('Attachments: contract.pdf (245KB)');
    expect(result).not.toContain('earlier draft');
    // Marker should appear before the attachments summary, not after.
    const markerIdx = result.indexOf(MARKER);
    const attachIdx = result.indexOf('Attachments:');
    expect(markerIdx).toBeLessThan(attachIdx);
  });

  it('Scenario: No-quote pass-through is identity', () => {
    const body = 'Just a short message with no quoted history at all.\n\nThanks.';
    expect(stripQuotedHistory(body)).toBe(body);
  });

  it('Scenario: Empty body returns empty', () => {
    expect(stripQuotedHistory('')).toBe('');
  });

  it('Scenario: Strip markdown-bolded Outlook header cluster (Outlook-365 / OWA shape)', () => {
    // node-html-markdown emits **From:** for bolded `<strong>From:</strong>` source HTML
    // — the common Outlook-on-the-web / Outlook-365 reply-header shape.
    const body = [
      'Yes.',
      '',
      '**From:** Alice <alice@corp.com>',
      '**Sent:** Wednesday, May 6, 2026 11:38 AM',
      '**To:** Bob <bob@corp.com>',
      '**Cc:** Carol <carol@corp.com>',
      '**Subject:** RE: Symposium logistics',
      '',
      'Hi Bob — could we move it to 10am?',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Yes.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Alice');
    expect(result).not.toContain('Hi Bob — could we move it to 10am?');
  });

  it('Scenario: Apple Mail "On <date>, at <time>, <name> wrote:" preamble (comma+at form)', () => {
    const body = [
      'Confirmed.',
      '',
      'On Apr 29, 2026, at 1:14 AM, Alice <alice@corp.com> wrote:',
      '> Want to grab coffee?',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Confirmed.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Want to grab coffee?');
  });

  it('Scenario: ISO-8601 "On YYYY-MM-DD HH:MM, <name> wrote:" preamble', () => {
    const body = [
      'Got it.',
      '',
      'On 2026-05-08 17:26, Alice White wrote:',
      '> Original message body.',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Got it.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Original message body.');
  });

  it('Scenario: Mixed bold and plain Outlook fields still satisfies cluster check', () => {
    // Some clients only bold a subset of the field labels.
    const body = [
      'Approved.',
      '',
      '**From:** Alice <alice@corp.com>',
      'Sent: Wednesday, May 6, 2026 11:38 AM',
      '**To:** Bob <bob@corp.com>',
      'Subject: RE: Symposium logistics',
      '',
      'Original body text here.',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Approved.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Original body text here.');
  });

  it('Scenario: Apple-Mail forward header uses Date instead of Sent', () => {
    // Apple Mail (and iPhone Mail) emit "Date:" in their quoted-message header block
    // where Outlook would emit "Sent:". The detector must recognize either.
    const body = [
      'Forwarding for awareness.',
      '',
      '**From:** Alice <alice@corp.com>',
      '**Date:** May 6, 2026 at 11:41:27 AM EDT',
      '**To:** Bob <bob@corp.com>',
      '**Subject:** Q2 plan',
      '',
      'Original Q2 plan content here.',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Forwarding for awareness.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Original Q2 plan content here.');
  });

  it('Scenario: CRLF line endings are tolerated', () => {
    // Some providers (including older Exchange) deliver bodies with CRLF separators.
    // Detection must still work. Note: lines retain trailing \r after split('\n');
    // regex anchors and trim() handle this.
    const body = [
      'Approved.',
      '',
      'On Wed Alice wrote:',
      '> earlier',
    ].join('\r\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Approved.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('earlier');
  });

  it('Scenario: Outlook-2003 "-----Original Message-----" separator', () => {
    // Plaintext separator emitted by older Outlook (and many corporate clients still).
    // Confirmed by McDermott-style forwards in real mailbox samples.
    const body = [
      'Forwarding for review.',
      '',
      '-----Original Message-----',
      'From: Alice <alice@corp.com>',
      'Sent: Tuesday, April 28, 2026 5:34 PM',
      'To: Bob <bob@corp.com>',
      'Subject: Q2 plan',
      '',
      'Original body content here.',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Forwarding for review.');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Original body content here.');
    expect(result).not.toContain('Original Message');
  });

  it('Scenario: Wrapped "On … wrote:" preamble (multi-line)', () => {
    // github/email_reply_parser test/emails/email_1_3.txt exercises wrapped preambles
    // where the "wrote:" tail spills onto the next line because of long sender info.
    const body = [
      'Thanks!',
      '',
      'On Thu, Jul 14, 2011 at 4:55 PM, Alice',
      '<alice@long-domain-example.com> wrote:',
      '> Original message body.',
    ].join('\n');

    const result = stripQuotedHistory(body);

    expect(result).toContain('Thanks!');
    expect(result).toContain(MARKER);
    expect(result).not.toContain('Original message body.');
  });

  it('Scenario: "On" line that does not wrap to "wrote:" is NOT mistaken for preamble', () => {
    // Important false-positive guard: lines starting with "On" must not trigger the
    // wrapped-preamble detector unless "wrote:" actually appears within 2 lines.
    const body = [
      'Quick update:',
      '',
      'On Friday I wrapped up the proposal. Sending the draft Monday.',
      '',
      'Feedback welcome.',
    ].join('\n');

    const result = stripQuotedHistory(body);
    expect(result).toBe(body);
  });

  it('Scenario: Custom marker is honored', () => {
    const body = [
      'Reply text.',
      '',
      'On Wed Alice wrote:',
      '> earlier',
    ].join('\n');

    const result = stripQuotedHistory(body, { marker: '[trimmed]' });
    expect(result).toContain('[trimmed]');
    expect(result).not.toContain(MARKER);
  });
});
