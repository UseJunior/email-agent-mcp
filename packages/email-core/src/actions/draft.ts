// Draft actions — create_draft, send_draft, update_draft
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { checkReplyThreading } from '../security/reply-validation.js';
import { ProviderError, withRetry } from '../providers/provider.js';
import { resolveBodyFile, truncateBody, BODY_SIZE_LIMIT } from '../content/body-loader.js';

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
  mailbox: z.string().optional(),
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
    if (!input.mailbox && ctx.allMailboxes && ctx.allMailboxes.length > 1) {
      return {
        success: false,
        error: { code: 'MAILBOX_REQUIRED', message: 'mailbox parameter required when multiple mailboxes are configured', recoverable: false },
      };
    }

    // Resolve body and frontmatter
    let body: string;
    let to = input.to;
    let cc = input.cc;
    let subject = input.subject;
    let replyTo = input.reply_to;

    if (input.body_file) {
      const bodyResult = await resolveBodyFile(input.body_file, ctx.safeDir);
      if (bodyResult.error) {
        return { success: false, error: bodyResult.error };
      }
      body = bodyResult.content!;

      // Frontmatter is authoritative
      if (bodyResult.frontmatter) {
        const fm = bodyResult.frontmatter;
        if (fm.to !== undefined) to = fm.to;
        if (fm.cc !== undefined) cc = Array.isArray(fm.cc) ? fm.cc : [fm.cc];
        if (fm.subject !== undefined) subject = fm.subject;
        if (fm.reply_to !== undefined) replyTo = fm.reply_to;
      }
    } else if (input.body) {
      body = input.body;
    } else {
      return {
        success: false,
        error: { code: 'MISSING_BODY', message: 'Either body or body_file is required', recoverable: false },
      };
    }

    // Validate required fields
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

    const recipients = Array.isArray(to) ? to : [to];

    // Check allowlist
    const allowlistError = checkSendAllowlist(recipients, ctx.sendAllowlist);
    if (allowlistError) {
      return {
        success: false,
        error: { code: 'ALLOWLIST_BLOCKED', message: allowlistError, recoverable: false },
      };
    }

    // Re: threading guardrail
    const threadingError = checkReplyThreading(subject, replyTo);
    if (threadingError) {
      return { success: false, error: threadingError };
    }

    // Truncate if needed
    if (Buffer.byteLength(body, 'utf-8') > BODY_SIZE_LIMIT) {
      body = truncateBody(body);
    }

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
        subject,
        body,
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
  description: 'Send a previously created draft. Rate-limited.',
  input: SendDraftInput,
  output: SendDraftOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement
    if (!input.mailbox && ctx.allMailboxes && ctx.allMailboxes.length > 1) {
      return {
        success: false,
        error: { code: 'MAILBOX_REQUIRED', message: 'mailbox parameter required when multiple mailboxes are configured', recoverable: false },
      };
    }

    // Check rate limit
    if (ctx.rateLimiter) {
      const rateCheck = ctx.rateLimiter.checkLimit('send_draft');
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
});

export const updateDraftAction: EmailAction<
  z.infer<typeof UpdateDraftInput>,
  z.infer<typeof DraftOutput>
> = {
  name: 'update_draft',
  description: 'Update a draft email. Re-checks allowlist if recipients change.',
  input: UpdateDraftInput,
  output: DraftOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check mailbox requirement
    if (!input.mailbox && ctx.allMailboxes && ctx.allMailboxes.length > 1) {
      return {
        success: false,
        error: { code: 'MAILBOX_REQUIRED', message: 'mailbox parameter required when multiple mailboxes are configured', recoverable: false },
      };
    }

    // Check provider supports updateDraft
    if (!ctx.provider.updateDraft) {
      return {
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Draft updates are not supported by this email provider', recoverable: false },
      };
    }

    // Resolve body from file if provided
    let body = input.body;
    let to = input.to;
    let cc = input.cc;
    let subject = input.subject;

    if (input.body_file) {
      const bodyResult = await resolveBodyFile(input.body_file, ctx.safeDir);
      if (bodyResult.error) {
        return { success: false, error: bodyResult.error };
      }
      body = bodyResult.content!;

      // Frontmatter is authoritative
      if (bodyResult.frontmatter) {
        const fm = bodyResult.frontmatter;
        if (fm.to !== undefined) to = fm.to;
        if (fm.cc !== undefined) cc = Array.isArray(fm.cc) ? fm.cc : [fm.cc];
        if (fm.subject !== undefined) subject = fm.subject;
      }
    }

    // Re-check allowlist if recipients changed
    if (to) {
      const recipients = Array.isArray(to) ? to : [to];
      const allowlistError = checkSendAllowlist(recipients, ctx.sendAllowlist);
      if (allowlistError) {
        return {
          success: false,
          error: { code: 'ALLOWLIST_BLOCKED', message: allowlistError, recoverable: false },
        };
      }
    }

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
      if (Buffer.byteLength(body, 'utf-8') > BODY_SIZE_LIMIT) {
        body = truncateBody(body);
      }
      partial.body = body;
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

// --- Shared error handler ---

function handleProviderError(err: unknown, fallbackCode: string) {
  if (err instanceof ProviderError) {
    return {
      success: false as const,
      error: { code: err.code, message: err.message, recoverable: err.recoverable },
    };
  }
  return {
    success: false as const,
    error: {
      code: fallbackCode,
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    },
  };
}
