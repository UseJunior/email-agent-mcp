// read_email action — return full content of a single email
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { transformEmailContent } from '../content/sanitize.js';
import { stripSignature } from '../content/signatures.js';

const ReadEmailInput = z.object({
  id: z.string(),
  mailbox: z.string().optional(),
  strip_signatures: z.boolean().optional().default(true),
});

const ReadEmailOutput = z.object({
  id: z.string(),
  subject: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  receivedAt: z.string(),
  body: z.string(),
  attachments: z.array(z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    isInline: z.boolean(),
  })).optional(),
});

export const readEmailAction: EmailAction<
  z.infer<typeof ReadEmailInput>,
  z.infer<typeof ReadEmailOutput>
> = {
  name: 'read_email',
  description: 'Read the full content of an email by ID, transformed to token-efficient markdown',
  input: ReadEmailInput,
  output: ReadEmailOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const msg = await ctx.provider.getMessage(input.id);

    let body = transformEmailContent(msg.body, msg.bodyHtml, msg.attachments);
    if (input.strip_signatures) {
      body = stripSignature(body);
    }

    return {
      id: msg.id,
      subject: msg.subject,
      from: msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email,
      to: msg.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email),
      cc: msg.cc?.map(a => a.name ? `${a.name} <${a.email}>` : a.email),
      receivedAt: msg.receivedAt,
      body,
      attachments: msg.attachments?.map(a => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        isInline: a.isInline,
      })),
    };
  },
};
