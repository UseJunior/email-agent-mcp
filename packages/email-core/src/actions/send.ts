// send_email action — compose and send new email, gated by send allowlist
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { checkReplyThreading } from '../security/reply-validation.js';
import { withRetry } from '../providers/provider.js';
import { truncateBody, BODY_SIZE_LIMIT } from '../content/body-loader.js';
import {
  checkMailboxRequired,
  resolveComposeFields,
  validateRequiredFields,
  checkRateLimit,
  handleProviderError,
} from './compose-helpers.js';

const SendEmailInput = z.object({
  to: z.string().or(z.array(z.string())).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  body_file: z.string().optional(),
  mailbox: z.string().optional(),
  draft: z.boolean().optional(),
});

const SendEmailOutput = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  draftId: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }).optional(),
});

export const sendEmailAction: EmailAction<
  z.infer<typeof SendEmailInput>,
  z.infer<typeof SendEmailOutput>
> = {
  name: 'send_email',
  description: 'Compose and send a new email. Gated by send allowlist. Draft mode bypasses allowlist.',
  input: SendEmailInput,
  output: SendEmailOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement for multi-mailbox
    const mailboxError = checkMailboxRequired(input.mailbox, ctx.allMailboxes);
    if (mailboxError) {
      return { success: false, error: mailboxError };
    }

    // Resolve body content and frontmatter
    const fields = await resolveComposeFields(input, ctx.safeDir);
    if (fields.error) {
      return { success: false, error: fields.error };
    }

    const { to, cc, subject, draft } = fields;
    let { body } = fields;

    // Validate required fields after merge
    const requiredError = validateRequiredFields(to, subject);
    if (requiredError) {
      return { success: false, error: requiredError };
    }

    // Resolve recipients
    const recipients = Array.isArray(to) ? to : [to!];

    // Re: threading guardrail
    const threadingError = checkReplyThreading(subject!);
    if (threadingError) {
      return { success: false, error: threadingError };
    }

    // Graceful body truncation
    if (Buffer.byteLength(body, 'utf-8') > BODY_SIZE_LIMIT) {
      body = truncateBody(body);
    }

    // Draft workflow — skip allowlist check and rate limit
    if (draft) {
      const draftResult = await ctx.provider.createDraft({
        to: recipients.map(email => ({ email })),
        cc: cc?.map(email => ({ email })),
        subject: subject!,
        body,
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
    }

    // Send path — check allowlist
    const allowlistError = checkSendAllowlist(recipients, ctx.sendAllowlist);
    if (allowlistError) {
      return {
        success: false,
        error: { code: 'ALLOWLIST_BLOCKED', message: allowlistError, recoverable: false },
      };
    }

    // Check rate limit
    const rateLimitError = checkRateLimit(ctx.rateLimiter, 'send_email');
    if (rateLimitError) {
      return rateLimitError;
    }

    // Send with retry on transient errors
    try {
      const result = await withRetry(
        () => ctx.provider.sendMessage({
          to: recipients.map(email => ({ email })),
          cc: cc?.map(email => ({ email })),
          subject: subject!,
          body,
        }),
        { maxRetries: 3, baseDelay: 1000 },
      );

      if (ctx.rateLimiter) {
        ctx.rateLimiter.recordUsage('send_email');
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
      return handleProviderError(err, 'SEND_FAILED');
    }
  },
};
