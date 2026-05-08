// Quoted-history stripping — heuristic detection of terminal reply chains in already-normalized
// markdown text emitted by the content engine. Operates after htmlToMarkdown, so blockquotes have
// already been flattened to `> ` lines, gmail_quote/Outlook header divs to plain text.

const DEFAULT_MARKER = '[...prior thread truncated]';

const ATTACHMENTS_SUMMARY_RE = /\n\nAttachments: [^\n]+\s*$/;
// "On <date>, <name> wrote:" preamble (Gmail / Apple Mail). Single-line variant.
const ON_WROTE_RE = /^On\b.+\bwrote:\s*$/;
// Wrapped variant: "On" line begins the preamble but the "wrote:" tail wraps to a later
// line because long sender/email/date strings push it. github/email_reply_parser exercises
// this in `test/emails/email_1_3.txt`. Match an "On" line that does NOT contain "wrote:" yet,
// confirmed only when "wrote:" appears within the next 2 lines.
const ON_LINE_PREFIX_RE = /^On\b/;
// Outlook reply headers come through node-html-markdown either as plain `From: …`
// or as markdown-bolded `**From:** …` (when the source HTML uses <strong>/<b>,
// which is the common case in Outlook-365 / Outlook-on-the-web). Match both shapes.
// `Date:` covers Apple Mail's quoted-message header where Apple uses Date instead of Sent.
const OUTLOOK_FROM_RE = /^(?:\*\*)?From:(?:\*\*)?\s/;
const OUTLOOK_FIELD_RE = /^(?:\*\*)?(?:Sent|Date|To|Subject|Cc|Bcc):(?:\*\*)?\s/;
// Outlook 2003-era plaintext separator. Outlook used "-----Original Message-----" before
// switching to the From:/Sent:/To:/Subject: header block. Older clients (and many forwards
// today) still emit it. Match with flexible whitespace around "Original Message".
const ORIGINAL_MESSAGE_RE = /^-{2,}\s*Original\s+Message\s*-{2,}\s*$/i;
const QUOTE_LINE_RE = /^>+/;

interface StripQuotedHistoryOptions {
  marker?: string;
}

/**
 * Strip a terminal quoted-history block from an email body and replace it with a short marker.
 * Detects the earliest valid terminal block among:
 *   - Gmail/Apple "On <date>, <name> wrote:" preamble validated by a following quote line or
 *     Outlook header cluster
 *   - Outlook header cluster (From: + at least two of Sent/To/Subject within a small window)
 *   - A terminal run of `>`-prefix lines with only blank lines between it and end-of-body
 *
 * Inline blockquotes appearing within the latest reply are preserved (i.e. a `>`-prefix line
 * that has non-quoted user content after it does not trigger stripping).
 *
 * Idempotent: returns the body unchanged when no terminal block is detected, and avoids
 * appending the marker twice when called repeatedly.
 */
export function stripQuotedHistory(body: string, opts?: StripQuotedHistoryOptions): string {
  if (!body) return body;
  const marker = opts?.marker ?? DEFAULT_MARKER;

  // The content engine (sanitize.ts) appends `\n\nAttachments: ...` after the body. Detach it
  // so detection scans only the message body, then re-attach after stripping.
  let attachmentsSummary = '';
  let scanBody = body;
  const attachMatch = body.match(ATTACHMENTS_SUMMARY_RE);
  if (attachMatch && attachMatch.index !== undefined) {
    attachmentsSummary = attachMatch[0];
    scanBody = body.slice(0, attachMatch.index);
  }

  const lines = scanBody.split('\n');
  const cutLine = findTerminalQuoteBlockStart(lines);
  if (cutLine === null) return body;

  const before = lines.slice(0, cutLine).join('\n').replace(/\s+$/, '');
  const stripped = before.endsWith(marker)
    ? before
    : before + (before ? '\n\n' : '') + marker;
  return stripped + attachmentsSummary;
}

function findTerminalQuoteBlockStart(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // "-----Original Message-----" Outlook-2003 separator. Strong signal on its own;
    // include the line in the cut so the marker replaces the whole block.
    if (ORIGINAL_MESSAGE_RE.test(line)) return i;

    if (ON_WROTE_RE.test(line)) {
      const next = lookAheadNonBlank(lines, i, 3);
      const hasQuote = next.some(l => QUOTE_LINE_RE.test(l));
      const hasOutlookCluster = checkOutlookClusterAt(lines, i + 1);
      if (hasQuote || hasOutlookCluster) return i;
    } else if (ON_LINE_PREFIX_RE.test(line) && lineWrapsToWrote(lines, i)) {
      // Wrapped "On <long sender info>\n<email>\nwrote:" preamble — only count when
      // "wrote:" lands within the next 2 lines AND there's a quote line or header
      // cluster after that, to keep false-positive risk low.
      const next = lookAheadNonBlank(lines, i + 2, 3);
      const hasQuote = next.some(l => QUOTE_LINE_RE.test(l));
      const hasOutlookCluster = checkOutlookClusterAt(lines, i + 3);
      if (hasQuote || hasOutlookCluster) return i;
    }

    if (OUTLOOK_FROM_RE.test(line) && checkOutlookClusterAt(lines, i)) {
      return i;
    }

    if (QUOTE_LINE_RE.test(line) && isTerminalQuoteBlock(lines, i)) {
      return i;
    }
  }
  return null;
}

function lineWrapsToWrote(lines: string[], from: number): boolean {
  for (let i = from + 1; i < lines.length && i <= from + 2; i++) {
    const l = lines[i] ?? '';
    if (/\bwrote:\s*$/.test(l)) return true;
  }
  return false;
}

function lookAheadNonBlank(lines: string[], from: number, n: number): string[] {
  const result: string[] = [];
  for (let i = from + 1; i < lines.length && result.length < n; i++) {
    const l = lines[i] ?? '';
    if (l.trim() !== '') result.push(l);
  }
  return result;
}

// Outlook reply headers look like:
//   From: Alice <alice@example.com>
//   Sent: Wednesday, March 13, 2024 9:30 AM
//   To: Bob <bob@example.com>
//   Subject: RE: Contract review
// We require a `From:` start and at least two more recognized fields among the next non-blank
// lines (so 3+ fields total) — a single "From: Alice" line in user content does not match.
function checkOutlookClusterAt(lines: string[], from: number): boolean {
  const nonBlank: string[] = [];
  for (let i = from; i < lines.length && nonBlank.length < 6; i++) {
    const l = lines[i] ?? '';
    if (l.trim() !== '') nonBlank.push(l);
  }
  if (nonBlank.length === 0 || !OUTLOOK_FROM_RE.test(nonBlank[0]!)) return false;
  let fieldCount = 1; // From:
  for (const l of nonBlank.slice(1, 5)) {
    if (OUTLOOK_FIELD_RE.test(l)) fieldCount += 1;
  }
  return fieldCount >= 3;
}

function isTerminalQuoteBlock(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() === '') continue;
    if (!QUOTE_LINE_RE.test(l)) return false;
  }
  return true;
}
