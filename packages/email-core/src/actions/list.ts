// list_emails action — list recent emails with filtering
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import {
  EmailDraftStatusSchema,
  EmailThreadFieldsSchema,
  getEmailDraftStatus,
  getEmailThreadFields,
} from './search.js';

const ListEmailsInput = z.object({
  mailbox: z.string().optional(),
  unread: z.boolean().optional(),
  limit: z.number().optional().default(25),
  offset: z.number().optional().default(0),
  folder: z.string().optional().default('inbox'),
  from: z.string().optional(),
});

const ListEmailsOutput = z.object({
  emails: z.array(z.object({
    id: z.string(),
    subject: z.string(),
    from: z.string(),
    receivedAt: z.string(),
    isRead: z.boolean(),
    hasAttachments: z.boolean(),
  }).extend(EmailThreadFieldsSchema.shape).extend(EmailDraftStatusSchema.shape)),
});

export const LIST_EMAILS_DESCRIPTION =
  'List recent emails with filtering by unread status, folder, sender, and limit. '
  + 'A row with `isDraft: true` is an unsent draft — it has NOT been sent, and its '
  + '`receivedAt` is provider-supplied metadata, not evidence of delivery. '
  + 'Never describe such a row as a sent, delivered, or received email.';

export const listEmailsAction: EmailAction<
  z.infer<typeof ListEmailsInput>,
  z.infer<typeof ListEmailsOutput>
> = {
  name: 'list_emails',
  description: LIST_EMAILS_DESCRIPTION,
  input: ListEmailsInput,
  output: ListEmailsOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const messages = await ctx.provider.listMessages({
      mailbox: input.mailbox ?? ctx.mailboxName,
      folder: input.folder,
      unread: input.unread,
      limit: input.limit,
      offset: input.offset,
      from: input.from,
    });

    return {
      emails: messages.map(m => ({
        id: m.id,
        subject: m.subject,
        from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
        receivedAt: m.receivedAt,
        isRead: m.isRead,
        hasAttachments: m.hasAttachments,
        ...getEmailThreadFields(m),
        ...getEmailDraftStatus(m),
      })),
    };
  },
};
