// list_emails action — list recent emails with filtering
import { z } from 'zod';
import type { EmailAction } from './registry.js';

const ListEmailsInput = z.object({
  mailbox: z.string().optional(),
  unread: z.boolean().optional(),
  limit: z.number().optional().default(25),
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
  })),
});

export const listEmailsAction: EmailAction<
  z.infer<typeof ListEmailsInput>,
  z.infer<typeof ListEmailsOutput>
> = {
  name: 'list_emails',
  description: 'List recent emails with filtering by unread status, folder, sender, and limit',
  input: ListEmailsInput,
  output: ListEmailsOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const messages = await ctx.provider.listMessages({
      mailbox: input.mailbox ?? ctx.mailboxName,
      folder: input.folder,
      unread: input.unread,
      limit: input.limit,
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
      })),
    };
  },
};
