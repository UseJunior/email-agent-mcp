// Shared helpers for compose actions — internal module, NOT exported from package root
import type { RateLimiter, MailboxEntry } from './registry.js';
import { ProviderError } from '../providers/provider.js';
import { resolveBodyFile } from '../content/body-loader.js';
import type { BodyFormat } from '../content/body-renderer.js';

// --- Error shape used by all actions ---

interface ActionError {
  code: string;
  message: string;
  recoverable: boolean;
}

// --- checkMailboxRequired ---

export function checkMailboxRequired(
  mailbox: string | undefined,
  allMailboxes: MailboxEntry[] | undefined,
): ActionError | null {
  if (!mailbox && allMailboxes && allMailboxes.length > 1) {
    return {
      code: 'MAILBOX_REQUIRED',
      message: 'mailbox parameter required when multiple mailboxes are configured',
      recoverable: false,
    };
  }
  return null;
}

// --- resolveComposeFields ---

export interface ComposeFields {
  body: string;
  to?: string | string[];
  cc?: string[];
  subject?: string;
  replyTo?: string;
  draft?: boolean;
  format?: BodyFormat;
  forceBlack?: boolean;
  /**
   * Merged attachments list: frontmatter values followed by parameter values,
   * preserving order. Dedup by resolved realpath happens later in
   * resolveAttachments.
   */
  attachments?: string[];
  replyAll?: boolean;
  error?: ActionError;
}

/**
 * Resolve body content from body/body_file and merge frontmatter.
 * Stays narrow: body resolution + frontmatter merge only.
 * Does NOT do required-field validation or mode branching.
 *
 * Precedence: frontmatter is authoritative for all scalar fields. The one
 * exception is `attachments`, which is ADDITIVE — frontmatter attachments
 * plus parameter attachments are unioned (dedup happens later in
 * attachment-loader). This lets users set defaults in the body_file and
 * still add one-off attachments from the tool call.
 *
 * For update_draft where body is optional, pass `bodyOptional: true`.
 */
export async function resolveComposeFields(
  input: {
    body?: string;
    body_file?: string;
    to?: string | string[];
    cc?: string[];
    subject?: string;
    reply_to?: string;
    draft?: boolean;
    format?: BodyFormat;
    force_black?: boolean;
    attachments?: string[];
    reply_all?: boolean;
  },
  safeDir?: string,
  opts?: { bodyOptional?: boolean },
): Promise<ComposeFields> {
  let body: string | undefined;
  let to = input.to;
  let cc = input.cc;
  let subject = input.subject;
  let replyTo = input.reply_to;
  let draft = input.draft;
  let format = input.format;
  let forceBlack = input.force_black;
  let replyAll = input.reply_all;
  const attachmentPaths: string[] = [];

  if (input.body_file) {
    const bodyResult = await resolveBodyFile(input.body_file, safeDir);
    if (bodyResult.error) {
      return { body: '', error: bodyResult.error };
    }
    body = bodyResult.content!;

    // Frontmatter is authoritative for scalars; attachments union below.
    if (bodyResult.frontmatter) {
      const fm = bodyResult.frontmatter;
      if (fm.to !== undefined) to = fm.to;
      if (fm.cc !== undefined) cc = Array.isArray(fm.cc) ? fm.cc : [fm.cc];
      if (fm.subject !== undefined) subject = fm.subject;
      if (fm.reply_to !== undefined) replyTo = fm.reply_to;
      if (fm.draft !== undefined) draft = fm.draft;
      if (fm.format !== undefined) format = fm.format;
      if (fm.force_black !== undefined) forceBlack = fm.force_black;
      if (fm.reply_all !== undefined) replyAll = fm.reply_all;
      if (fm.attachments) attachmentPaths.push(...fm.attachments);
    }
  } else if (input.body) {
    body = input.body;
  } else if (!opts?.bodyOptional) {
    return {
      body: '',
      error: { code: 'MISSING_BODY', message: 'Either body or body_file is required', recoverable: false },
    };
  }

  if (input.attachments?.length) {
    attachmentPaths.push(...input.attachments);
  }

  return {
    body: body ?? '',
    to,
    cc,
    subject,
    replyTo,
    draft,
    format,
    forceBlack,
    attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
    replyAll,
  };
}

// --- validateRequiredFields ---

export function validateRequiredFields(
  to: string | string[] | undefined,
  subject: string | undefined,
): ActionError | null {
  if (!to) {
    return {
      code: 'MISSING_FIELD',
      message: 'to is required — provide it as a parameter or in body_file frontmatter',
      recoverable: false,
    };
  }
  if (!subject) {
    return {
      code: 'MISSING_FIELD',
      message: 'subject is required — provide it as a parameter or in body_file frontmatter',
      recoverable: false,
    };
  }
  return null;
}

// --- checkRateLimit ---

export function checkRateLimit(
  rateLimiter: RateLimiter | undefined,
  actionName: string,
): { success: false; error: ActionError } | null {
  if (!rateLimiter) return null;
  const rateCheck = rateLimiter.checkLimit(actionName);
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
  return null;
}

// --- handleProviderError ---

export function handleProviderError(err: unknown, fallbackCode: string) {
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
