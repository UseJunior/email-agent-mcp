// reply_to_email action — reply within existing thread, gated by send allowlist
import { z } from 'zod';
import type { EmailAction, ActionContext } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { ProviderError, withRetry } from '../providers/provider.js';

const ReplyToEmailInput = z.object({
  message_id: z.string(),
  body: z.string(),
  mailbox: z.string().optional(),
  cc: z.array(z.string()).optional(),
});

const ReplyToEmailOutput = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
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
  description: 'Reply to an email within an existing thread. Gated by send allowlist.',
  input: ReplyToEmailInput,
  output: ReplyToEmailOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement for multi-mailbox
    if (!input.mailbox && ctx.allMailboxes && ctx.allMailboxes.length > 1) {
      return {
        success: false,
        error: {
          code: 'MAILBOX_REQUIRED',
          message: 'mailbox parameter required when multiple mailboxes are configured',
          recoverable: false,
        },
      };
    }

    // Get the original message to check the recipient against allowlist
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
    if (ctx.rateLimiter) {
      const rateCheck = ctx.rateLimiter.checkLimit('reply_to_email');
      if (!rateCheck.allowed) {
        return {
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: `Send rate limit exceeded. Retry after ${rateCheck.retryAfter}s`,
            recoverable: true,
          },
        };
      }
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
      if (err instanceof ProviderError) {
        return {
          success: false,
          error: { code: err.code, message: err.message, recoverable: err.recoverable },
        };
      }
      return {
        success: false,
        error: {
          code: 'REPLY_FAILED',
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        },
      };
    }
  },
};
