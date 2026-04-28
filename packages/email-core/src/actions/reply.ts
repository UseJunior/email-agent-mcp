// reply_to_email action — reply within existing thread, gated by send allowlist
import { z } from 'zod';
import type { ActionContext, EmailAction } from './registry.js';
import type { EmailMessage } from '../types.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { isPlausibleMessageId } from '../security/reply-validation.js';
import { withRetry } from '../providers/provider.js';
import { renderEmailBody } from '../content/body-renderer.js';
import {
  checkMailboxRequired,
  checkRateLimit,
  handleProviderError,
} from './compose-helpers.js';

const ReplyToEmailInput = z.object({
  message_id: z.string(),
  body: z.string(),
  mailbox: z.string().optional(),
  cc: z.array(z.string()).optional(),
  draft: z.boolean().optional(),
  reply_all: z.boolean().optional().default(true)
    .describe('When false, reply only to the original sender. Default true preserves reply-all behavior (cc the original thread).'),
  format: z.enum(['markdown', 'html', 'text']).optional()
    .describe("Body format. 'markdown' (default) renders via GFM with line-break preservation; 'html' is passthrough; 'text' sends as plain text."),
  force_black: z.boolean().optional()
    .describe('Wrap rendered HTML in a force-black div so Outlook dark mode does not hide the text. Default true.'),
});

const ReplyToEmailOutput = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  draftId: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }).optional(),
});

function collectCurrentMailboxEmails(ctx: ActionContext): Set<string> {
  const currentMailboxEmails = new Set<string>();

  if (ctx.mailboxName?.includes('@')) {
    currentMailboxEmails.add(ctx.mailboxName.toLowerCase());
  }

  const resolvedMailbox = ctx.mailboxName
    ? ctx.allMailboxes?.find(mailbox =>
      mailbox.name.toLowerCase() === ctx.mailboxName!.toLowerCase()
      || mailbox.emailAddress?.toLowerCase() === ctx.mailboxName!.toLowerCase(),
    )
    : (ctx.allMailboxes?.length === 1
      ? ctx.allMailboxes[0]
      : ctx.allMailboxes?.find(mailbox => mailbox.isDefault));

  if (resolvedMailbox?.emailAddress) {
    currentMailboxEmails.add(resolvedMailbox.emailAddress.toLowerCase());
  }

  return currentMailboxEmails;
}

function collectReplyAllowlistRecipients(
  ctx: ActionContext,
  originalMessage: EmailMessage,
  input: z.infer<typeof ReplyToEmailInput>,
): string[] {
  const currentMailboxEmails = collectCurrentMailboxEmails(ctx);
  const recipients: string[] = [];
  const seen = new Set<string>();

  const addRecipient = (email: string, opts?: { skipCurrentMailbox?: boolean }) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    if (opts?.skipCurrentMailbox && currentMailboxEmails.has(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    recipients.push(email);
  };

  addRecipient(originalMessage.from.email);

  if (input.reply_all !== false) {
    for (const recipient of originalMessage.to) {
      addRecipient(recipient.email, { skipCurrentMailbox: true });
    }
    for (const recipient of originalMessage.cc ?? []) {
      addRecipient(recipient.email, { skipCurrentMailbox: true });
    }
  }

  for (const recipient of input.cc ?? []) {
    addRecipient(recipient);
  }

  return recipients;
}

export const replyToEmailAction: EmailAction<
  z.infer<typeof ReplyToEmailInput>,
  z.infer<typeof ReplyToEmailOutput>
> = {
  name: 'reply_to_email',
  description: 'Reply to an email within an existing thread. Default reply_all=true cc\'s the original thread; pass reply_all=false to reply only to the sender. Send path validates all effective recipients against the send allowlist; draft path bypasses.',
  input: ReplyToEmailInput,
  output: ReplyToEmailOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement for multi-mailbox
    const mailboxError = checkMailboxRequired(input.mailbox, ctx.allMailboxes);
    if (mailboxError) {
      return { success: false, error: mailboxError };
    }

    // Validate message ID plausibility
    if (!isPlausibleMessageId(input.message_id)) {
      return {
        success: false,
        error: {
          code: 'INVALID_MESSAGE_ID',
          message: 'message_id does not appear to be a valid provider message ID',
          recoverable: false,
        },
      };
    }

    // Render body: markdown → HTML by default
    const rendered = renderEmailBody(input.body, { format: input.format, forceBlack: input.force_black });
    const bodyPlain = rendered.body;
    const bodyHtml = rendered.bodyHtml;

    // Draft branch — create reply draft, bypass allowlist
    if (input.draft) {
      if (!ctx.provider.createReplyDraft) {
        return {
          success: false,
          error: {
            code: 'NOT_SUPPORTED',
            message: 'Reply drafts are not supported by this email provider',
            recoverable: false,
          },
        };
      }
      try {
        const draftResult = await ctx.provider.createReplyDraft(input.message_id, bodyPlain, {
          cc: input.cc?.map(email => ({ email })),
          bodyHtml,
          replyAll: input.reply_all,
        });
        return {
          success: draftResult.success,
          draftId: draftResult.draftId,
          error: draftResult.error ? {
            code: draftResult.error.code,
            message: draftResult.error.message,
            recoverable: draftResult.error.recoverable,
          } : undefined,
        };
      } catch (err) {
        return handleProviderError(err, 'DRAFT_FAILED');
      }
    }

    // Send path — check every effective recipient against the allowlist
    const originalMessage = await ctx.provider.getMessage(input.message_id);
    const replyRecipients = collectReplyAllowlistRecipients(ctx, originalMessage, input);

    // Check send allowlist — reply recipients must also be allowed
    const allowlistError = checkSendAllowlist(replyRecipients, ctx.sendAllowlist);
    if (allowlistError) {
      return {
        success: false,
        error: {
          code: 'ALLOWLIST_BLOCKED',
          message: allowlistError.includes('not configured')
            ? allowlistError
            : `Recipient not in send allowlist`,
          recoverable: false,
        },
      };
    }

    // Check rate limit
    const rateLimitError = checkRateLimit(ctx.rateLimiter, 'reply_to_email');
    if (rateLimitError) {
      return rateLimitError;
    }

    try {
      const result = await withRetry(
        () => ctx.provider.replyToMessage(input.message_id, bodyPlain, {
          cc: input.cc?.map(email => ({ email })),
          bodyHtml,
          replyAll: input.reply_all,
        }),
        { maxRetries: 3, baseDelay: 1000 },
      );

      if (ctx.rateLimiter) {
        ctx.rateLimiter.recordUsage('reply_to_email');
      }

      return {
        success: result.success,
        messageId: result.messageId,
        error: result.error ? {
          code: result.error.code,
          message: result.error.message,
          recoverable: result.error.recoverable,
        } : undefined,
      };
    } catch (err) {
      return handleProviderError(err, 'REPLY_FAILED');
    }
  },
};
