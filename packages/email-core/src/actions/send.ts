// send_email action — compose and send new email, gated by send allowlist
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { checkReplyThreading } from '../security/reply-validation.js';
import { ProviderError, withRetry } from '../providers/provider.js';
import { resolveBodyFile, truncateBody, BODY_SIZE_LIMIT } from '../content/body-loader.js';

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
  description: 'Compose and send a new email. Gated by send allowlist.',
  input: SendEmailInput,
  output: SendEmailOutput,
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

    // Resolve body content and frontmatter
    let body: string;
    let to = input.to;
    let cc = input.cc;
    let subject = input.subject;
    let draft = input.draft;

    if (input.body_file) {
      const bodyResult = await resolveBodyFile(input.body_file, ctx.safeDir);
      if (bodyResult.error) {
        return { success: false, error: bodyResult.error };
      }
      body = bodyResult.content!;

      // Frontmatter is authoritative — overrides action params for fields it declares
      if (bodyResult.frontmatter) {
        const fm = bodyResult.frontmatter;
        if (fm.to !== undefined) to = fm.to;
        if (fm.cc !== undefined) {
          cc = Array.isArray(fm.cc) ? fm.cc : [fm.cc];
        }
        if (fm.subject !== undefined) subject = fm.subject;
        if (fm.draft !== undefined) draft = fm.draft;
      }
    } else if (input.body) {
      body = input.body;
    } else {
      return {
        success: false,
        error: { code: 'MISSING_BODY', message: 'Either body or body_file is required', recoverable: false },
      };
    }

    // Validate required fields after merge
    if (!to) {
      return {
        success: false,
        error: { code: 'MISSING_FIELD', message: 'to is required — provide it as a parameter or in body_file frontmatter', recoverable: false },
      };
    }
    if (!subject) {
      return {
        success: false,
        error: { code: 'MISSING_FIELD', message: 'subject is required — provide it as a parameter or in body_file frontmatter', recoverable: false },
      };
    }

    // Resolve recipients
    const recipients = Array.isArray(to) ? to : [to];

    // Check send allowlist
    const allowlistError = checkSendAllowlist(recipients, ctx.sendAllowlist);
    if (allowlistError) {
      return {
        success: false,
        error: { code: 'ALLOWLIST_BLOCKED', message: allowlistError, recoverable: false },
      };
    }

    // Re: threading guardrail
    const threadingError = checkReplyThreading(subject);
    if (threadingError) {
      return { success: false, error: threadingError };
    }

    // Check rate limit
    if (ctx.rateLimiter) {
      const rateCheck = ctx.rateLimiter.checkLimit('send_email');
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

    // Graceful body truncation
    if (Buffer.byteLength(body, 'utf-8') > BODY_SIZE_LIMIT) {
      body = truncateBody(body);
    }

    // Draft workflow
    if (draft) {
      const draftResult = await ctx.provider.createDraft({
        to: recipients.map(email => ({ email })),
        cc: cc?.map(email => ({ email })),
        subject,
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

    // Send with retry on transient errors
    try {
      const result = await withRetry(
        () => ctx.provider.sendMessage({
          to: recipients.map(email => ({ email })),
          cc: cc?.map(email => ({ email })),
          subject,
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
      if (err instanceof ProviderError) {
        return {
          success: false,
          error: {
            code: err.code,
            message: err.message,
            recoverable: err.recoverable,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'SEND_FAILED',
          message: err instanceof Error ? err.message : String(err),
          recoverable: false,
        },
      };
    }
  },
};
