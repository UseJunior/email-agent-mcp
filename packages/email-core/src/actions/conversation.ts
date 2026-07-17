// get_thread action — retrieve conversation thread by message ID
import { z } from 'zod';
import type { EmailAction } from './registry.js';

const GetThreadInput = z.object({
  message_id: z.string(),
  mailbox: z.string().optional(),
});

const GetThreadOutput = z.object({
  id: z.string(),
  subject: z.string(),
  messages: z.array(z.object({
    id: z.string(),
    subject: z.string(),
    from: z.string(),
    // Recipient topology per message as explicit arrays (`[]` when none), so a
    // caller reasoning about reply-all scope on a multi-party thread can see who
    // was on To/Cc rather than inferring absence from a missing field — issue #102.
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    receivedAt: z.string(),
    body: z.string().optional(),
    isRead: z.boolean(),
  })),
  messageCount: z.number(),
  isTruncated: z.boolean().optional(),
});

export const getThreadAction: EmailAction<
  z.infer<typeof GetThreadInput>,
  z.infer<typeof GetThreadOutput>
> = {
  name: 'get_thread',
  description: 'Retrieve all messages in a conversation thread by message ID',
  input: GetThreadInput,
  output: GetThreadOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const thread = await ctx.provider.getThread(input.message_id);

    // Gmail 100-message cap
    const MAX_THREAD_MESSAGES = 100;
    const isTruncated = thread.messages.length > MAX_THREAD_MESSAGES;
    const messages = isTruncated
      ? thread.messages.slice(-MAX_THREAD_MESSAGES)
      : thread.messages;

    return {
      id: thread.id,
      subject: thread.subject,
      messages: messages.map(m => ({
        id: m.id,
        subject: m.subject,
        from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
        to: m.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email),
        cc: (m.cc ?? []).map(a => a.name ? `${a.name} <${a.email}>` : a.email),
        bcc: (m.bcc ?? []).map(a => a.name ? `${a.name} <${a.email}>` : a.email),
        receivedAt: m.receivedAt,
        body: m.body,
        isRead: m.isRead,
      })),
      messageCount: thread.messages.length,
      isTruncated,
    };
  },
};
