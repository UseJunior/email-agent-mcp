// Quoted-history stripping — heuristic detection of terminal reply chains in already-normalized
// markdown text emitted by the content engine. Operates after htmlToMarkdown, so blockquotes have
// already been flattened to `> ` lines, gmail_quote/Outlook header divs to plain text.
//
// The detector is English-only: "On … wrote:" preambles and "From:/Sent:/Date:/To:/Subject:"
// header clusters are matched by their English labels. Localized clients ("Am … schrieb …",
// "Le … a écrit", "送信者:") are NOT detected and their threads will be returned with full
// quoted history. This is an explicit scope cut.

const DEFAULT_MARKER = '[...prior thread truncated]';

const ATTACHMENTS_SUMMARY_RE = /\n\nAttachments: [^\n]+\s*$/;
// "On <date>, <name> wrote:" preamble (Gmail / Apple Mail). Single-line variant.
const ON_WROTE_RE = /^On\b.+\bwrote:\s*$/;
// Wrapped variant: "On" line begins the preamble but the "wrote:" tail wraps to a later
// line because long sender/email/date strings push it. github/email_reply_parser exercises
// this in `test/emails/email_1_3.txt`. Match an "On" line that does NOT contain "wrote:" yet,
// confirmed only when "wrote:" appears within the next 2 lines.
const ON_LINE_PREFIX_RE = /^On\b/;
// Bare "wrote:" tail of a wrapped preamble (e.g. `<alice@long.example> wrote:`).
const WROTE_TAIL_RE = /\bwrote:\s*$/;
// Outlook reply headers come through node-html-markdown either as plain `From: …`
// or as markdown-bolded `**From:** …` (when the source HTML uses <strong>/<b>,
// which is the common case in Outlook-365 / Outlook-on-the-web). Match both shapes,
// including the colon-outside-bold variant `**From**: …` that some markdown converters emit.
// `Date:` covers Apple Mail's quoted-message header where Apple uses Date instead of Sent.
const OUTLOOK_FROM_RE = /^(?:\*\*)?From(?:\*\*)?\s*:(?:\*\*)?\s/;
const OUTLOOK_FIELD_RE = /^(?:\*\*)?(?:Sent|Date|To|Subject|Cc|Bcc)(?:\*\*)?\s*:(?:\*\*)?\s/;
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
 *   - Outlook-2003 `-----Original Message-----` separator followed by an Outlook header cluster
 *   - Gmail/Apple "On <date>, <name> wrote:" preamble validated by a following quote line or
 *     Outlook header cluster, AND with no user prose between the cut and end-of-body
 *   - Outlook header cluster (From: + at least two of Sent/Date/To/Subject within a small window)
 *   - A terminal run of `>`-prefix lines with only blank lines between it and end-of-body
 *
 * "Terminal" means: the first non-history line after the candidate cut is end-of-body. An inline
 * `On … wrote:` quote followed by user prose is NOT stripped — only the genuine bottom-of-thread
 * pattern is.
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

  // Upstream HTML-to-markdown flattens block-level `<div>` content onto a single line
  // (the content engine's hidden-element translator returns no block formatting for
  // div/span/p outside of `<p>` paragraphs). That means real Outlook reply HTML often
  // arrives as `Confirmed.From: Alice<a@x.com>Sent: …To: …Subject: …Body.` with no
  // line breaks separating header fields. Restore line boundaries before scanning so
  // the line-anchored detectors can fire.
  scanBody = normalizeHeaderBoundaries(scanBody);

  const lines = scanBody.split('\n');
  const cutLine = findTerminalQuoteBlockStart(lines);
  if (cutLine === null) return body;

  const before = lines.slice(0, cutLine).join('\n').replace(/\s+$/, '');
  const stripped = before.endsWith(marker)
    ? before
    : before + (before ? '\n\n' : '') + marker;
  return stripped + attachmentsSummary;
}

// Pre-scan normalization: inject newlines before recognized header tokens and `On … wrote:`
// preambles when they appear glued mid-line. The HTML normalizer flattens `<div>From:</div>`
// blocks into inline runs, so without this step the line-anchored detectors miss any
// Outlook header cluster that came from div-based source HTML.
//
// Safety: header-field insertions only fire when followed by `\s` after the colon (so a
// stray "From:" without a header value is left alone), and the cluster detector still
// requires ≥3 fields, so a single mid-prose `From:` cannot trigger stripping. The
// `On … wrote:` insertion only fires when `wrote:` actually appears later on the same
// physical line, and the terminal-tail validator still has to pass.
function normalizeHeaderBoundaries(body: string): string {
  let out = body;
  // Insert before bolded or plain header field markers: From|Sent|Date|To|Subject|Cc|Bcc
  // Forms supported: `From: `, `**From:** `, `**From**: `.
  out = out.replace(
    /([^\s\n])((?:\*\*)?(?:From|Sent|Date|To|Subject|Cc|Bcc)(?:\*\*)?\s*:(?:\*\*)?\s)/g,
    '$1\n$2',
  );
  // Insert before `On … wrote:` only when `wrote:` is on the same physical line.
  out = out.replace(/([^\s\n])(On\b[^\n]+\bwrote:)/g, '$1\n$2');
  return out;
}

function findTerminalQuoteBlockStart(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // "-----Original Message-----" Outlook-2003 separator. Cut here only if a real
    // Outlook header cluster follows — without that, the separator could be user
    // prose (e.g. literary use). Followed cluster + plaintext body is treated as
    // forwarded content and is allowed to extend to EOF without further validation.
    if (ORIGINAL_MESSAGE_RE.test(line)) {
      if (checkOutlookClusterAt(lines, nextNonBlankIndex(lines, i + 1))) return i;
      continue;
    }

    if (ON_WROTE_RE.test(line)) {
      const next = lookAheadNonBlank(lines, i, 3);
      const hasQuote = next.some(l => QUOTE_LINE_RE.test(l));
      const hasOutlookCluster = checkOutlookClusterAt(lines, i + 1);
      if ((hasQuote || hasOutlookCluster) && isTailQuotedHistoryOnly(lines, i + 1)) {
        return i;
      }
      continue;
    }

    if (ON_LINE_PREFIX_RE.test(line)) {
      const wroteIdx = findWroteWithin(lines, i, 2);
      if (wroteIdx !== -1) {
        const next = lookAheadNonBlank(lines, wroteIdx, 3);
        const hasQuote = next.some(l => QUOTE_LINE_RE.test(l));
        const hasOutlookCluster = checkOutlookClusterAt(lines, wroteIdx + 1);
        if ((hasQuote || hasOutlookCluster) && isTailQuotedHistoryOnly(lines, wroteIdx + 1)) {
          return i;
        }
      }
      continue;
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

function findWroteWithin(lines: string[], from: number, withinLines: number): number {
  for (let i = from + 1; i < lines.length && i <= from + withinLines; i++) {
    const l = lines[i] ?? '';
    if (WROTE_TAIL_RE.test(l)) return i;
  }
  return -1;
}

function nextNonBlankIndex(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '') return i;
  }
  return lines.length;
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

// Verify the lines from `fromIdx` to EOF look like a continuation of quoted history rather
// than a return to user-authored prose. Used for the `On … wrote:` preamble where Gmail/Apple
// always `>`-prefix the quoted body — a non-quoted, non-header line below the preamble means
// the user added text after pulling in an inline quote, so we must NOT cut.
//
// Allowed continuation shapes:
//   - blank line
//   - `>`-prefix quote
//   - Outlook field (From/Sent/Date/To/Subject/Cc/Bcc, plain or bolded)
//   - another `On … wrote:` preamble (nested)
//   - a wrapped `On …` preamble (we jump past it)
//   - `-----Original Message-----` separator
//
// Any other non-blank line aborts validation. Plaintext "original message body" is intentionally
// rejected here because this validator is only used for the Gmail/Apple `On … wrote:` path,
// which always uses `>` prefixing. The Outlook cluster path has its own (more permissive)
// terminal model.
function isTailQuotedHistoryOnly(lines: string[], fromIdx: number): boolean {
  let i = fromIdx;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (QUOTE_LINE_RE.test(line)) {
      i++;
      continue;
    }
    if (OUTLOOK_FROM_RE.test(line) || OUTLOOK_FIELD_RE.test(line)) {
      i++;
      continue;
    }
    if (ORIGINAL_MESSAGE_RE.test(line)) {
      i++;
      continue;
    }
    if (ON_WROTE_RE.test(line)) {
      i++;
      continue;
    }
    if (ON_LINE_PREFIX_RE.test(line)) {
      const wroteIdx = findWroteWithin(lines, i, 2);
      if (wroteIdx !== -1) {
        i = wroteIdx + 1;
        continue;
      }
    }
    return false;
  }
  return true;
}
