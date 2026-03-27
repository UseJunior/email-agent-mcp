// search_emails action — full-text search using provider's native query
import { z } from 'zod';
import type { EmailAction } from './registry.js';

const SearchEmailsInput = z.object({
  query: z.string(),
  mailbox: z.string().nullable().optional(),
  limit: z.number().optional().default(25),
});

const SearchEmailsOutput = z.object({
  emails: z.array(z.object({
    id: z.string(),
    subject: z.string(),
    from: z.string(),
    receivedAt: z.string(),
    isRead: z.boolean(),
    hasAttachments: z.boolean(),
    mailbox: z.string().optional(),
    snippet: z.string().optional(),
  })),
});

export const searchEmailsAction: EmailAction<
  z.infer<typeof SearchEmailsInput>,
  z.infer<typeof SearchEmailsOutput>
> = {
  name: 'search_emails',
  description: 'Search emails using full-text query across one or all mailboxes',
  input: SearchEmailsInput,
  output: SearchEmailsOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    // If mailbox is null, search across all configured mailboxes
    if (input.mailbox === null && ctx.allMailboxes && ctx.allMailboxes.length > 1) {
      const allResults = await Promise.all(
        ctx.allMailboxes.map(async (mb) => {
          const results = await mb.provider.searchMessages(input.query);
          return results.map(m => ({ ...m, mailbox: mb.name }));
        }),
      );
      const merged = allResults.flat()
        .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
        .slice(0, input.limit);

      return {
        emails: merged.map(m => ({
          id: m.id,
          subject: m.subject,
          from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
          receivedAt: m.receivedAt,
          isRead: m.isRead,
          hasAttachments: m.hasAttachments,
          mailbox: m.mailbox,
          snippet: m.snippet,
        })),
      };
    }

    const results = await ctx.provider.searchMessages(input.query);
    return {
      emails: results.slice(0, input.limit).map(m => ({
        id: m.id,
        subject: m.subject,
        from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
        receivedAt: m.receivedAt,
        isRead: m.isRead,
        hasAttachments: m.hasAttachments,
        mailbox: ctx.mailboxName,
        snippet: m.snippet,
      })),
    };
  },
};
