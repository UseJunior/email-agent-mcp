// send_email action — compose and send new email, gated by send allowlist
import { z } from 'zod';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import type { EmailAction, ActionContext } from './registry.js';
import { checkSendAllowlist } from '../security/send-allowlist.js';
import { ProviderError, withRetry } from '../providers/provider.js';

const BODY_SIZE_LIMIT = 3.5 * 1024 * 1024; // 3.5MB
const TEXT_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.text']);

const SendEmailInput = z.object({
  to: z.string().or(z.array(z.string())),
  cc: z.array(z.string()).optional(),
  subject: z.string(),
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

    // Resolve recipients
    const recipients = Array.isArray(input.to) ? input.to : [input.to];

    // Check send allowlist
    const allowlistError = checkSendAllowlist(recipients, ctx.sendAllowlist);
    if (allowlistError) {
      return {
        success: false,
        error: { code: 'ALLOWLIST_BLOCKED', message: allowlistError, recoverable: false },
      };
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

    // Resolve body content
    let body: string;
    if (input.body_file) {
      const bodyResult = await resolveBodyFile(input.body_file, ctx.safeDir);
      if (bodyResult.error) {
        return { success: false, error: bodyResult.error };
      }
      body = bodyResult.content!;
    } else if (input.body) {
      body = input.body;
    } else {
      return {
        success: false,
        error: { code: 'MISSING_BODY', message: 'Either body or body_file is required', recoverable: false },
      };
    }

    // Graceful body truncation
    if (Buffer.byteLength(body, 'utf-8') > BODY_SIZE_LIMIT) {
      body = truncateBody(body, BODY_SIZE_LIMIT);
    }

    // Draft workflow
    if (input.draft) {
      const draftResult = await ctx.provider.createDraft({
        to: recipients.map(email => ({ email })),
        cc: input.cc?.map(email => ({ email })),
        subject: input.subject,
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
          cc: input.cc?.map(email => ({ email })),
          subject: input.subject,
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

async function resolveBodyFile(
  bodyFile: string,
  safeDir?: string,
): Promise<{ content?: string; error?: { code: string; message: string; recoverable: boolean } }> {
  const baseDir = safeDir ?? process.cwd();
  const resolved = resolve(baseDir, bodyFile);

  // Check path traversal
  if (bodyFile.includes('..') || (isAbsolute(bodyFile) && !resolved.startsWith(baseDir))) {
    return {
      error: {
        code: 'PATH_TRAVERSAL',
        message: 'body_file must be within the working directory',
        recoverable: false,
      },
    };
  }

  // Verify it's within the safe directory
  const rel = relative(baseDir, resolved);
  if (rel.startsWith('..')) {
    return {
      error: {
        code: 'PATH_TRAVERSAL',
        message: 'body_file must be within the working directory',
        recoverable: false,
      },
    };
  }

  // Check if file exists and is not a symlink escape
  try {
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink()) {
      const realPath = await realpath(resolved);
      if (!realPath.startsWith(baseDir)) {
        return {
          error: {
            code: 'SYMLINK_ESCAPE',
            message: 'body_file symlink targets outside working directory',
            recoverable: false,
          },
        };
      }
    }
  } catch {
    return {
      error: {
        code: 'FILE_NOT_FOUND',
        message: `body_file not found: ${bodyFile}`,
        recoverable: false,
      },
    };
  }

  // Check file extension
  const ext = extname(resolved).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) {
    return {
      error: {
        code: 'INVALID_FILE_TYPE',
        message: 'body_file must be a text file (.md, .html, .txt)',
        recoverable: false,
      },
    };
  }

  // Read file and check for binary content
  const content = await readFile(resolved);

  // Binary file detection: check for null bytes
  if (content.includes(0)) {
    return {
      error: {
        code: 'BINARY_FILE',
        message: 'body_file must be a text file (.md, .html, .txt)',
        recoverable: false,
      },
    };
  }

  return { content: content.toString('utf-8') };
}

function truncateBody(body: string, maxBytes: number): string {
  const truncationNotice = '\n\nThis response was truncated because it exceeded email size limits.';
  const targetSize = maxBytes - Buffer.byteLength(truncationNotice, 'utf-8');

  // Find a safe cut point — don't cut inside HTML tags
  let cutPoint = targetSize;
  const encoded = Buffer.from(body, 'utf-8');
  if (encoded.length <= maxBytes) return body;

  // Back up to the last closing tag or newline
  const truncated = encoded.subarray(0, cutPoint).toString('utf-8');
  const lastTagClose = truncated.lastIndexOf('>');
  const lastNewline = truncated.lastIndexOf('\n');
  const safeCut = Math.max(lastTagClose + 1, lastNewline + 1, cutPoint - 1000);

  return truncated.substring(0, safeCut) + truncationNotice;
}
