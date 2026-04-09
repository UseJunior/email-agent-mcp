// reply_to_email action — reply within existing thread, gated by send allowlist.
//
// Send-path design: we create a reply draft via the provider, fetch the draft
// to see exactly which recipients Graph/Gmail auto-populated, allowlist-check
// *those* recipients, and only then send. This closes the window where a
// reply-all could send to a recipient that was never checked against the
// allowlist (see CVE-style note in plan §2.0 / P0 fix).
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { isPlausibleMessageId } from '../security/reply-validation.js';
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
    .describe('Reply to all recipients (to + cc) when true (default), or only the sender when false.'),
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

    // Render body: markdown → HTML by default
    const rendered = renderEmailBody(input.body, { format: input.format, forceBlack: input.force_black });
    const bodyPlain = rendered.body;
    const bodyHtml = rendered.bodyHtml;

    // Every code path below goes through createReplyDraft — draft and send.
    // This keeps the allowlist gate on the *actual* populated recipients and
    // lets attachment upload share one code path with create_draft.
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

    // Draft branch — create reply draft, bypass allowlist (enforced at send time)
    if (input.draft) {
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

    // Send path — create reply draft, then allowlist-check the actual recipients
    // the provider populated (to + cc), then sendDraft. This closes the reply-all
    // allowlist bypass: the old code only checked original.from.email, but Graph's
    // createReplyAll auto-populates every original recipient.
    let draftId: string | undefined;
    try {
      const draftResult = await ctx.provider.createReplyDraft(input.message_id, bodyPlain, {
        cc: input.cc?.map(email => ({ email })),
        bodyHtml,
        replyAll: input.reply_all,
      });
      if (!draftResult.success || !draftResult.draftId) {
        return {
          success: false,
          error: draftResult.error
            ? { code: draftResult.error.code, message: draftResult.error.message, recoverable: draftResult.error.recoverable }
            : { code: 'DRAFT_FAILED', message: 'createReplyDraft returned no draftId', recoverable: false },
        };
      }
      draftId = draftResult.draftId;
    } catch (err) {
      return handleProviderError(err, 'DRAFT_FAILED');
    }

    // Fetch the draft to see the actual recipients the provider populated
    let populatedRecipients: string[];
    try {
      const draftMessage = await ctx.provider.getMessage(draftId);
      populatedRecipients = [
        ...(draftMessage.to?.map(a => a.email) ?? []),
        ...(draftMessage.cc?.map(a => a.email) ?? []),
      ];
    } catch (err) {
      // If we can't verify recipients, fail closed and try to clean up the draft.
      await safeDeleteDraft(ctx.provider, draftId);
      return {
        success: false,
        error: {
          code: 'DRAFT_LOOKUP_FAILED',
          message: `Cannot verify reply recipients before sending: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
        },
      };
    }

    if (populatedRecipients.length === 0) {
      await safeDeleteDraft(ctx.provider, draftId);
      return {
        success: false,
        error: { code: 'NO_RECIPIENTS', message: 'Reply draft has no recipients', recoverable: false },
      };
    }

    // Allowlist-check the populated recipients
    const allowlistError = checkSendAllowlist(populatedRecipients, ctx.sendAllowlist);
    if (allowlistError) {
      await safeDeleteDraft(ctx.provider, draftId);
      return {
        success: false,
        error: {
          code: 'ALLOWLIST_BLOCKED',
          message: allowlistError.includes('not configured')
            ? allowlistError
            : `One or more reply recipients not in send allowlist`,
          recoverable: false,
        },
      };
    }

    // Check rate limit
    const rateLimitError = checkRateLimit(ctx.rateLimiter, 'reply_to_email');
    if (rateLimitError) {
      await safeDeleteDraft(ctx.provider, draftId);
      return rateLimitError;
    }

    try {
      const result = await ctx.provider.sendDraft(draftId);
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

// Delete a draft, swallowing errors. Used on failure paths where the caller
// already has a fatal error to return and just wants to clean up.
async function safeDeleteDraft(
  provider: { deleteMessage?: (id: string, hard?: boolean) => Promise<string | void> },
  draftId: string,
): Promise<void> {
  if (!provider.deleteMessage) return;
  try {
    await provider.deleteMessage(draftId, true);
  } catch (err) {
    process.stderr.write(
      `[email-agent-mcp] WARNING: failed to clean up reply draft ${draftId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
