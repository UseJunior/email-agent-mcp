// read_email action — return full content of a single email
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { transformEmailContent } from '../content/sanitize.js';
import { stripSignature } from '../content/signatures.js';
import { stripQuotedHistory } from '../content/quotes.js';
import { truncateForPreview } from './compose-helpers.js';
import { EmailDraftStatusSchema, getEmailDraftStatus } from './search.js';

// Byte cap on the `body` returned for `format: 'html'` — the raw HTML, and the
// plain-text fallback when the message has no HTML part, since both are the same
// `format: 'html'` response headed for the same budget. The markdown path is
// deliberately left uncapped: it is the default, and the default does not change.
//
// Mirrors the PREVIEW_BODY_LIMIT budget that bounds draft previews, but is
// deliberately larger than that 32 KB preview cap:
// a preview exists so an agent can *eyeball* what was persisted, whereas the
// raw-HTML read exists so an agent can round-trip a formatted body — edit one
// sentence and write the rest back byte-identical. Truncating that defeats the
// entire purpose, and Outlook-authored HTML with inline `mso-` styling routinely
// runs well past 32 KB for a body whose markdown reduction is a few KB. 256 KB
// covers hand-authored formatted mail with headroom while still bounding the
// MCP response. Exceeding it is signalled via `bodyTruncated`, never silently cut.
export const READ_HTML_BODY_LIMIT = 256 * 1024;

const ReadEmailInput = z.object({
  id: z.string(),
  mailbox: z.string().optional(),
  strip_signatures: z.boolean().optional().default(true),
  strip_quoted_history: z.boolean().optional().default(false),
  format: z.enum(['markdown', 'html']).optional().default('markdown')
    .describe(
      "'markdown' (default) returns the token-efficient markdown conversion. "
      + "'html' returns the message's raw body HTML verbatim, so inline styling "
      + '(colour, background-colour, underline, strikethrough) survives a '
      + 'read-edit-write round trip that markdown would destroy.',
    ),
});

const ReadEmailOutput = z.object({
  id: z.string(),
  subject: z.string(),
  from: z.string(),
  // Recipient topology is always surfaced as explicit arrays so a caller can
  // distinguish "no Cc recipients" (`[]`) from "not reported" — see issue #102.
  // bcc is only ever populated on the sender's own copy of a message (the field
  // is stripped from recipients' copies by design), so it is `[]` for most reads.
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  receivedAt: z.string(),
  body: z.string(),
  // Always present, following the recipient-topology precedent in issue #102: an
  // omitted key is ambiguous, and a caller about to write this body back needs to
  // know unambiguously what it is holding. `text` is reported when `format: 'html'`
  // was requested but the message carries no HTML part — writing a plain-text body
  // back as HTML would mangle it, so that case must be distinguishable from `html`.
  bodyFormat: z.enum(['markdown', 'html', 'text'])
    .describe('What `body` actually contains: the markdown conversion, the raw message HTML, or the plain-text body when `format: "html"` was requested and the message has no HTML part.'),
  bodyTruncated: z.boolean().optional()
    .describe('True if `body` was truncated to fit the MCP response budget. Only ever set when `format: "html"` was requested (the markdown path is unbounded, exactly as before); the message itself is unchanged. Do NOT write a truncated body back to a draft.'),
  attachments: z.array(z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    contentId: z.string().optional(),
    isInline: z.boolean(),
  })).optional(),
}).extend(EmailDraftStatusSchema.shape);

export const READ_EMAIL_DESCRIPTION =
  'Read the full content of an email by ID, transformed to token-efficient markdown. '
  + "Set format to 'html' to get the raw body HTML instead — use this when you need to "
  + 'preserve inline styling (colour, background-colour, underline, strikethrough) that the '
  + 'markdown conversion discards, e.g. to change one sentence of a formatted body and leave '
  + 'the rest alone. Raw HTML costs far more tokens than markdown, so leave the default alone '
  + 'unless you need the styling. The returned HTML is verbatim: `strip_signatures` and '
  + '`strip_quoted_history` are markdown-shaped text transforms and are NOT applied when '
  + "format is 'html'. Before writing a body back, check `bodyFormat` — `text` means the "
  + 'message had no HTML part, so do not send it as HTML — and check `bodyTruncated`, which '
  + 'means you do not have the whole body and must not write it back. When you do write raw '
  + "HTML back, pass format: 'html' AND force_black: false, or the compose action wraps your "
  + 'HTML in a force-black div and every round trip nests another one. '
  + 'When the response has `isDraft: true` the message is an unsent draft — it has NOT '
  + 'been sent, and `receivedAt` is provider-supplied metadata, not evidence of delivery. '
  + 'Never describe it as a sent, delivered, or received email.';

export const readEmailAction: EmailAction<
  z.infer<typeof ReadEmailInput>,
  z.infer<typeof ReadEmailOutput>
> = {
  name: 'read_email',
  description: READ_EMAIL_DESCRIPTION,
  input: ReadEmailInput,
  output: ReadEmailOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const msg = await ctx.provider.getMessage(input.id);

    let body: string;
    let bodyFormat: 'markdown' | 'html' | 'text';
    let bodyTruncated = false;

    if (input.format === 'html') {
      // Verbatim: no markdown conversion, no attachment summary appended, and no
      // signature/quote stripping. Every one of those rewrites the string, and the
      // whole point of this branch is that what comes out can be written back in.
      // Attachments are still reported structurally in `attachments`.
      const raw = msg.bodyHtml;
      // No HTML part — fall back to the plain-text body rather than returning
      // nothing, and say so via `bodyFormat` so the caller does not write plain
      // text back as HTML. (Both parts absent yields `''` with `bodyFormat: 'text'`,
      // which is honest: there is nothing to round-trip.)
      bodyFormat = raw !== undefined ? 'html' : 'text';
      // The cap applies to whichever body this branch returns, not only to real
      // HTML. The text fallback is still a `format: 'html'` response headed for the
      // same MCP budget, and an unbounded one truncated by the transport instead
      // would arrive silently mangled with no flag on it. The markdown path stays
      // uncapped exactly as before — that is the default and it must not change.
      const cut = truncateForPreview(raw ?? msg.body ?? '', READ_HTML_BODY_LIMIT);
      body = cut.text;
      bodyTruncated = cut.truncated;
    } else {
      bodyFormat = 'markdown';
      body = transformEmailContent(msg.body, msg.bodyHtml, msg.attachments);
      // Quote stripping runs first: shrinking the body lets the signature heuristic
      // (signatures.ts:33-39 uses a 30%-of-body-length threshold) actually fire on
      // signatures in the latest reply, which would otherwise be dwarfed by the thread tail.
      if (input.strip_quoted_history) {
        body = stripQuotedHistory(body);
      }
      if (input.strip_signatures) {
        body = stripSignature(body);
      }
    }

    return {
      id: msg.id,
      subject: msg.subject,
      from: msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email,
      to: msg.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email),
      cc: (msg.cc ?? []).map(a => a.name ? `${a.name} <${a.email}>` : a.email),
      bcc: (msg.bcc ?? []).map(a => a.name ? `${a.name} <${a.email}>` : a.email),
      receivedAt: msg.receivedAt,
      ...getEmailDraftStatus(msg),
      body,
      bodyFormat,
      // Omitted rather than `false` when nothing was cut: the flag is a warning,
      // and the common case should not carry one. Mirrors DraftPreviewSchema's
      // bodyTruncated / bodyHtmlTruncated, which are set only when they fire.
      ...(bodyTruncated ? { bodyTruncated: true } : {}),
      attachments: msg.attachments?.map(a => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        contentId: a.contentId,
        isInline: a.isInline,
      })),
    };
  },
};
