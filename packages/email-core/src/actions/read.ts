// read_email action — return full content of a single email
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { transformEmailContent } from '../content/sanitize.js';
import { stripSignature } from '../content/signatures.js';
import { stripQuotedHistory } from '../content/quotes.js';
import { EmailDraftStatusSchema, getEmailDraftStatus } from './search.js';

const ReadEmailInput = z.object({
  id: z.string(),
  mailbox: z.string().optional(),
  strip_signatures: z.boolean().optional().default(true),
  strip_quoted_history: z.boolean().optional().default(false),
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
  + 'When the response has `isDraft: true` the message is an unsent draft — it has NOT '
  + 'been sent, and `receivedAt` is when the draft was created or last edited, not a '
  + 'delivery time. Never describe it as a sent, delivered, or received email.';

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

    let body = transformEmailContent(msg.body, msg.bodyHtml, msg.attachments);
    // Quote stripping runs first: shrinking the body lets the signature heuristic
    // (signatures.ts:33-39 uses a 30%-of-body-length threshold) actually fire on
    // signatures in the latest reply, which would otherwise be dwarfed by the thread tail.
    if (input.strip_quoted_history) {
      body = stripQuotedHistory(body);
    }
    if (input.strip_signatures) {
      body = stripSignature(body);
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
