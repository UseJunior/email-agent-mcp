// Draft actions — create_draft, send_draft, update_draft
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { checkReplyThreading } from '../security/reply-validation.js';
import { withRetry } from '../providers/provider.js';
import { truncateBody, BODY_SIZE_LIMIT } from '../content/body-loader.js';
import { renderEmailBody } from '../content/body-renderer.js';
import { resolveAttachments } from '../content/attachment-loader.js';
import {
  checkMailboxRequired,
  resolveComposeFields,
  validateRequiredFields,
  checkRateLimit,
  handleProviderError,
} from './compose-helpers.js';

// --- Shared schemas ---

const DraftOutput = z.object({
  success: z.boolean(),
  draftId: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }).optional(),
});

// --- create_draft ---

const CreateDraftInput = z.object({
  to: z.string().or(z.array(z.string())).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  body_file: z.string().optional(),
  reply_to: z.string().optional(),
  reply_all: z.boolean().optional().default(true)
    .describe('For reply drafts (reply_to set): reply to all original recipients (default) or only the sender. Ignored for non-reply drafts.'),
  attachments: z.array(z.string()).optional()
    .describe('File paths to attach. Paths are resolved against EMAIL_AGENT_MCP_ATTACHMENT_DIR (must be set). 3 MiB max per file. Merged additively with any attachments listed in body_file frontmatter.'),
  mailbox: z.string().optional(),
  format: z.enum(['markdown', 'html', 'text']).optional()
    .describe("Body format. 'markdown' (default) renders via GFM with line-break preservation; 'html' is passthrough; 'text' sends as plain text."),
  force_black: z.boolean().optional()
    .describe('Wrap rendered HTML in a force-black div so Outlook dark mode does not hide the text. Default true.'),
});

export const createDraftAction: EmailAction<
  z.infer<typeof CreateDraftInput>,
  z.infer<typeof DraftOutput>
> = {
  name: 'create_draft',
  description: 'Create an email draft. Supports body_file with YAML frontmatter. Use reply_to for threaded reply drafts.',
  input: CreateDraftInput,
  output: DraftOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement
    const mailboxError = checkMailboxRequired(input.mailbox, ctx.allMailboxes);
    if (mailboxError) {
      return { success: false, error: mailboxError };
    }

    // Resolve body and frontmatter
    const fields = await resolveComposeFields(input, ctx.safeDir);
    if (fields.error) {
      return { success: false, error: fields.error };
    }

    const { to, cc, subject, replyTo, format, forceBlack, attachments: attachmentPaths, replyAll: fmReplyAll } = fields;
    let { body } = fields;
    // Frontmatter-sourced reply_all overrides the param (matches "frontmatter wins" convention)
    const effectiveReplyAll = fmReplyAll !== undefined ? fmReplyAll : input.reply_all;

    // Validate required fields.
    //
    // Reply drafts are special: when reply_to is set, the provider auto-populates
    // `to` (and `cc` if reply_all) from the original thread, so we don't require
    // `to` or `subject` up front — matching foam-email-calendar's behavior. The
    // exception is reply_all=false + no `to`, which is a real mistake (you'd
    // want the narrowed recipient to be explicit).
    if (!replyTo) {
      const requiredError = validateRequiredFields(to, subject);
      if (requiredError) {
        return { success: false, error: requiredError };
      }
    } else if (effectiveReplyAll === false && !to) {
      return {
        success: false,
        error: {
          code: 'MISSING_FIELD',
          message: 'to is required when reply_all=false (reply narrows to a single recipient that must be explicit)',
          recoverable: false,
        },
      };
    }

    const recipients = to ? (Array.isArray(to) ? to : [to]) : [];

    // Drafts bypass allowlist — enforcement happens at send_draft time

    // Re: threading guardrail (only when we have a subject to check)
    if (subject) {
      const threadingError = checkReplyThreading(subject, replyTo);
      if (threadingError) {
        return { success: false, error: threadingError };
      }
    }

    // Resolve attachments (frontmatter + param, unioned, dedup by realpath).
    // Fail closed if the env var is misconfigured or any file is invalid —
    // we never want to create a partial draft.
    let resolvedAttachments;
    if (attachmentPaths?.length) {
      const res = await resolveAttachments(attachmentPaths);
      if (res.error) {
        return { success: false, error: res.error };
      }
      resolvedAttachments = res.attachments;
    }

    // Render body: markdown → HTML by default
    const rendered = renderEmailBody(body, { format, forceBlack });
    let outBody = rendered.body;
    let outBodyHtml = rendered.bodyHtml;

    if (Buffer.byteLength(outBody, 'utf-8') > BODY_SIZE_LIMIT) {
      outBody = truncateBody(outBody);
    }
    if (outBodyHtml !== undefined && Buffer.byteLength(outBodyHtml, 'utf-8') > BODY_SIZE_LIMIT) {
      outBodyHtml = truncateBody(outBodyHtml);
    }
    body = outBody;

    // Reply draft path
    if (replyTo) {
      if (!ctx.provider.createReplyDraft) {
        return {
          success: false,
          error: { code: 'NOT_SUPPORTED', message: 'Reply drafts are not supported by this email provider', recoverable: false },
        };
      }
      try {
        const result = await ctx.provider.createReplyDraft(replyTo, body, {
          cc: cc?.map(email => ({ email })),
          bodyHtml: outBodyHtml,
          replyAll: effectiveReplyAll,
          attachments: resolvedAttachments,
        });
        return {
          success: result.success,
          draftId: result.draftId,
          error: result.error ? { code: result.error.code, message: result.error.message, recoverable: result.error.recoverable } : undefined,
        };
      } catch (err) {
        return handleProviderError(err, 'DRAFT_FAILED');
      }
    }

    // Standard draft path
    try {
      const result = await ctx.provider.createDraft({
        to: recipients.map(email => ({ email })),
        cc: cc?.map(email => ({ email })),
        subject: subject!,
        body,
        bodyHtml: outBodyHtml,
        attachments: resolvedAttachments,
      });
      return {
        success: result.success,
        draftId: result.draftId,
        error: result.error ? { code: result.error.code, message: result.error.message, recoverable: result.error.recoverable } : undefined,
      };
    } catch (err) {
      return handleProviderError(err, 'DRAFT_FAILED');
    }
  },
};

// --- send_draft ---

const SendDraftInput = z.object({
  draft_id: z.string(),
  mailbox: z.string().optional(),
});

const SendDraftOutput = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }).optional(),
});

export const sendDraftAction: EmailAction<
  z.infer<typeof SendDraftInput>,
  z.infer<typeof SendDraftOutput>
> = {
  name: 'send_draft',
  description: 'Send a previously created draft. Enforces send allowlist before sending. Rate-limited.',
  input: SendDraftInput,
  output: SendDraftOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement
    const mailboxError = checkMailboxRequired(input.mailbox, ctx.allMailboxes);
    if (mailboxError) {
      return { success: false, error: mailboxError };
    }

    // Fetch draft to check recipients against allowlist (fail closed)
    let draftMessage;
    try {
      draftMessage = await ctx.provider.getMessage(input.draft_id);
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'DRAFT_LOOKUP_FAILED',
          message: `Cannot verify draft recipients before sending: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
        },
      };
    }

    const recipients = [
      ...(draftMessage.to?.map(a => a.email) ?? []),
      ...(draftMessage.cc?.map(a => a.email) ?? []),
    ];
    if (recipients.length === 0) {
      return {
        success: false,
        error: { code: 'NO_RECIPIENTS', message: 'Draft has no recipients', recoverable: false },
      };
    }

    const allowlistError = checkSendAllowlist(recipients, ctx.sendAllowlist);
    if (allowlistError) {
      return {
        success: false,
        error: { code: 'ALLOWLIST_BLOCKED', message: allowlistError, recoverable: false },
      };
    }

    // Check rate limit
    const rateLimitError = checkRateLimit(ctx.rateLimiter, 'send_draft');
    if (rateLimitError) {
      return rateLimitError;
    }

    try {
      const result = await withRetry(
        () => ctx.provider.sendDraft(input.draft_id),
        { maxRetries: 3, baseDelay: 1000 },
      );

      if (ctx.rateLimiter) {
        ctx.rateLimiter.recordUsage('send_draft');
      }

      return {
        success: result.success,
        messageId: result.messageId,
        error: result.error ? { code: result.error.code, message: result.error.message, recoverable: result.error.recoverable } : undefined,
      };
    } catch (err) {
      return handleProviderError(err, 'SEND_DRAFT_FAILED');
    }
  },
};

// --- update_draft ---

const UpdateDraftInput = z.object({
  draft_id: z.string(),
  to: z.string().or(z.array(z.string())).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  body_file: z.string().optional(),
  mailbox: z.string().optional(),
  format: z.enum(['markdown', 'html', 'text']).optional()
    .describe("Body format. 'markdown' (default) renders via GFM with line-break preservation; 'html' is passthrough; 'text' sends as plain text."),
  force_black: z.boolean().optional()
    .describe('Wrap rendered HTML in a force-black div so Outlook dark mode does not hide the text. Default true.'),
});

export const updateDraftAction: EmailAction<
  z.infer<typeof UpdateDraftInput>,
  z.infer<typeof DraftOutput>
> = {
  name: 'update_draft',
  description: 'Update a draft email. Allowlist is enforced at send_draft time, not here.',
  input: UpdateDraftInput,
  output: DraftOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement
    const mailboxError = checkMailboxRequired(input.mailbox, ctx.allMailboxes);
    if (mailboxError) {
      return { success: false, error: mailboxError };
    }

    // Check provider supports updateDraft
    if (!ctx.provider.updateDraft) {
      return {
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Draft updates are not supported by this email provider', recoverable: false },
      };
    }

    // Resolve body from file if provided (body is optional for updates)
    const fields = await resolveComposeFields(input, ctx.safeDir, { bodyOptional: true });
    if (fields.error) {
      return { success: false, error: fields.error };
    }

    const { to, cc, subject, format, forceBlack } = fields;
    let { body } = fields;

    // Drafts bypass allowlist — enforcement happens at send_draft time

    // Re: threading guardrail on subject if changed
    if (subject) {
      const threadingError = checkReplyThreading(subject);
      if (threadingError) {
        return { success: false, error: threadingError };
      }
    }

    // Build partial update
    const partial: Partial<import('../types.js').ComposeMessage> = {};
    if (to) {
      const recipients = Array.isArray(to) ? to : [to];
      partial.to = recipients.map(email => ({ email }));
    }
    if (cc) partial.cc = cc.map(email => ({ email }));
    if (subject) partial.subject = subject;
    if (body) {
      const rendered = renderEmailBody(body, { format, forceBlack });
      let outBody = rendered.body;
      let outBodyHtml = rendered.bodyHtml;
      if (Buffer.byteLength(outBody, 'utf-8') > BODY_SIZE_LIMIT) {
        outBody = truncateBody(outBody);
      }
      if (outBodyHtml !== undefined && Buffer.byteLength(outBodyHtml, 'utf-8') > BODY_SIZE_LIMIT) {
        outBodyHtml = truncateBody(outBodyHtml);
      }
      body = outBody;
      partial.body = body;
      if (outBodyHtml !== undefined) partial.bodyHtml = outBodyHtml;
    }

    try {
      const result = await ctx.provider.updateDraft(input.draft_id, partial);
      return {
        success: result.success,
        draftId: result.draftId,
        error: result.error ? { code: result.error.code, message: result.error.message, recoverable: result.error.recoverable } : undefined,
      };
    } catch (err) {
      return handleProviderError(err, 'UPDATE_DRAFT_FAILED');
    }
  },
};
