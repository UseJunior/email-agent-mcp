// reply_to_email action — reply within existing thread, gated by send allowlist
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { isPlausibleMessageId } from '../security/reply-validation.js';
import { withRetry } from '../providers/provider.js';
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

export const replyToEmailAction: EmailAction<
  z.infer<typeof ReplyToEmailInput>,
  z.infer<typeof ReplyToEmailOutput>
> = {
  name: 'reply_to_email',
  description: 'Reply to an email within an existing thread. Send path gated by send allowlist; draft path bypasses.',
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
        const draftResult = await ctx.provider.createReplyDraft(input.message_id, input.body, {
          cc: input.cc?.map(email => ({ email })),
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

    // Send path — get the original message to check the recipient against allowlist
    const originalMessage = await ctx.provider.getMessage(input.message_id);
    const replyRecipient = originalMessage.from.email;

    // Check send allowlist — reply recipients must also be allowed
    const allowlistError = checkSendAllowlist([replyRecipient], ctx.sendAllowlist);
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
        () => ctx.provider.replyToMessage(input.message_id, input.body, {
          cc: input.cc?.map(email => ({ email })),
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
