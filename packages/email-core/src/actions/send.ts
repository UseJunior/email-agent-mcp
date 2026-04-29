// send_email action — compose and send new email, gated by send allowlist
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { checkReplyThreading } from '../security/reply-validation.js';
import { withRetry } from '../providers/provider.js';
import { truncateBody, BODY_SIZE_LIMIT } from '../content/body-loader.js';
import { renderEmailBody } from '../content/body-renderer.js';
import {
  checkMailboxRequired,
  resolveComposeFields,
  validateRequiredFields,
  checkRateLimit,
  handleProviderError,
  parseRecipients,
} from './compose-helpers.js';

const SendEmailInput = z.object({
  to: z.string().or(z.array(z.string())).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  body_file: z.string().optional(),
  mailbox: z.string().optional(),
  draft: z.boolean().optional(),
  format: z.enum(['markdown', 'html', 'text']).optional()
    .describe("Body format. 'markdown' (default) renders via GFM with line-break preservation; 'html' is passthrough; 'text' sends as plain text."),
  force_black: z.boolean().optional()
    .describe('Wrap rendered HTML in a force-black div so Outlook dark mode does not hide the text. Default true. Ignored when format is "text".'),
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

    const { to, cc, subject, draft, format, forceBlack } = fields;
    let { body } = fields;

    // Validate required fields after merge
    const requiredError = validateRequiredFields(to, subject);
    if (requiredError) {
      return { success: false, error: requiredError };
    }

    // Resolve recipients
    const recipients = Array.isArray(to) ? to : [to!];

    // Parse name-address strings ('Jane <jane@x>') into {name, email} once,
    // before allowlist or provider call, so both consume the same parsed list.
    const parsed = parseRecipients({ to: recipients, cc });
    if ('error' in parsed) {
      return { success: false, error: parsed.error };
    }

    // Re: threading guardrail
    const threadingError = checkReplyThreading(subject!);
    if (threadingError) {
      return { success: false, error: threadingError };
    }

    // Render body for transport: markdown → HTML by default.
    // Provider branches on bodyHtml to pick HTML vs Text content-type; the
    // raw source stays in `body` as a plain-text fallback.
    const rendered = renderEmailBody(body, { format, forceBlack });
    let outBody = rendered.body;
    let outBodyHtml = rendered.bodyHtml;

    // Graceful truncation — each field independently capped at size limit.
    if (Buffer.byteLength(outBody, 'utf-8') > BODY_SIZE_LIMIT) {
      outBody = truncateBody(outBody);
    }
    if (outBodyHtml !== undefined && Buffer.byteLength(outBodyHtml, 'utf-8') > BODY_SIZE_LIMIT) {
      outBodyHtml = truncateBody(outBodyHtml);
    }
    body = outBody;

    // Draft workflow — skip allowlist check and rate limit
    if (draft) {
      const draftResult = await ctx.provider.createDraft({
        to: parsed.to,
        cc: parsed.cc,
        subject: subject!,
        body,
        bodyHtml: outBodyHtml,
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

    // Send path — check allowlist (use parsed bare emails so name-address form passes correctly)
    const allowlistError = checkSendAllowlist(parsed.to.map(a => a.email), ctx.sendAllowlist);
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
          to: parsed.to,
          cc: parsed.cc,
          subject: subject!,
          body,
          bodyHtml: outBodyHtml,
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
