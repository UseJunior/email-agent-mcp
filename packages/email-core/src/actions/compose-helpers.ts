// Shared helpers for compose actions — internal module, NOT exported from package root
import { z } from 'zod';
import type { RateLimiter, MailboxEntry } from './registry.js';
import { ProviderError } from '../providers/provider.js';
import type { EmailReader } from '../providers/provider.js';
import { resolveBodyFile, truncateBody } from '../content/body-loader.js';
import type { BodyFormat } from '../content/body-renderer.js';
import { parseAddressList } from '../utils/address.js';
import type { EmailAddress } from '../types.js';

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
  error?: ActionError;
}

/**
 * Resolve body content from body/body_file and merge frontmatter.
 * Stays narrow: body resolution + frontmatter merge only.
 * Does NOT do required-field validation or mode branching.
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

  if (input.body_file) {
    const bodyResult = await resolveBodyFile(input.body_file, safeDir);
    if (bodyResult.error) {
      return { body: '', error: bodyResult.error };
    }
    body = bodyResult.content!;

    // Frontmatter is authoritative
    if (bodyResult.frontmatter) {
      const fm = bodyResult.frontmatter;
      if (fm.to !== undefined) to = fm.to;
      if (fm.cc !== undefined) cc = Array.isArray(fm.cc) ? fm.cc : [fm.cc];
      if (fm.subject !== undefined) subject = fm.subject;
      if (fm.reply_to !== undefined) replyTo = fm.reply_to;
      if (fm.draft !== undefined) draft = fm.draft;
      if (fm.format !== undefined) format = fm.format;
      if (fm.force_black !== undefined) forceBlack = fm.force_black;
    }
  } else if (input.body) {
    body = input.body;
  } else if (!opts?.bodyOptional) {
    return {
      body: '',
      error: { code: 'MISSING_BODY', message: 'Either body or body_file is required', recoverable: false },
    };
  }

  return { body: body ?? '', to, cc, subject, replyTo, draft, format, forceBlack };
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

// --- parseRecipients ---

export type ParsedRecipients =
  | { to: EmailAddress[]; cc: EmailAddress[] }
  | { error: ActionError };

export function parseRecipients(input: { to?: string[]; cc?: string[] }): ParsedRecipients {
  const toResult = parseAddressList(input.to, 'to');
  if (!toResult.ok) {
    return {
      error: {
        code: 'INVALID_ADDRESS',
        message: `${toResult.field}[${toResult.index}] invalid address: "${toResult.value}"`,
        recoverable: false,
      },
    };
  }
  const ccResult = parseAddressList(input.cc, 'cc');
  if (!ccResult.ok) {
    return {
      error: {
        code: 'INVALID_ADDRESS',
        message: `${ccResult.field}[${ccResult.index}] invalid address: "${ccResult.value}"`,
        recoverable: false,
      },
    };
  }
  return { to: toResult.addresses, cc: ccResult.addresses };
}

// --- Draft preview ---

// Per-field cap on body/bodyHtml in draft preview responses. The 3.5 MB
// BODY_SIZE_LIMIT in body-loader.ts is the email composition size cap, not a
// safe MCP tool-response budget — returning that much would blow LLM context
// and transport limits. 32 KB is enough for an agent to verify the rendered
// body without overwhelming the response.
export const PREVIEW_BODY_LIMIT = 32 * 1024;

const EmailAddressSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
});

export const DraftPreviewSchema = z.object({
  to: z.array(EmailAddressSchema).optional(),
  cc: z.array(EmailAddressSchema).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  bodyHtml: z.string().optional(),
});

export type DraftPreview = z.infer<typeof DraftPreviewSchema>;

/**
 * Build a preview block by reading the persisted draft back from the provider.
 *
 * The preview reflects PERSISTED state, not caller input — that is the point.
 * It surfaces persistence-layer drops (e.g. Microsoft Graph createDraft cc/bcc
 * drop, tracked in #48) without callers needing a separate read_email round
 * trip. See issue #75.
 *
 * Read-back failures are swallowed: returns undefined so the caller can still
 * report success on the underlying create/update. Logging is intentionally
 * absent — ActionContext does not currently carry a logger.
 */
export async function buildDraftPreview(
  provider: Pick<EmailReader, 'getMessage'>,
  draftId: string,
): Promise<DraftPreview | undefined> {
  try {
    const persisted = await provider.getMessage(draftId);
    const preview: DraftPreview = {
      to: persisted.to,
      cc: persisted.cc,
      subject: persisted.subject,
    };
    if (persisted.body !== undefined) {
      preview.body = truncateBody(persisted.body, PREVIEW_BODY_LIMIT);
    }
    if (persisted.bodyHtml !== undefined) {
      preview.bodyHtml = truncateBody(persisted.bodyHtml, PREVIEW_BODY_LIMIT);
    }
    return preview;
  } catch {
    return undefined;
  }
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
