// Shared helpers for compose actions — internal module, NOT exported from package root
import { z } from 'zod';
import type { RateLimiter, MailboxEntry } from './registry.js';
import { ProviderError } from '../providers/provider.js';
import type { EmailReader } from '../providers/provider.js';
import { resolveBodyFile } from '../content/body-loader.js';
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

// Delay between the first failed read-back and the retry. Providers can have a
// brief read-after-write window after createDraft/updateDraft.
export const PREVIEW_RETRY_DELAY_MS = 500;

const EmailAddressSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
});

export const DraftPreviewSchema = z.object({
  to: z.array(EmailAddressSchema).optional(),
  cc: z.array(EmailAddressSchema).optional(),
  // bcc intentionally omitted in v1: Gmail's mapGmailMessage at
  // packages/provider-gmail/src/email-gmail-provider.ts (mapGmailMessage) does
  // not parse the Bcc header, and Graph's mapGraphMessage similarly does not
  // surface bcc on EmailMessage. Action-layer read-back cannot make
  // preview.bcc meaningful without provider work; tracked as a follow-up.
  subject: z.string().optional(),
  body: z.string().optional(),
  bodyHtml: z.string().optional(),
  bodyTruncated: z.boolean().optional()
    .describe('True if preview.body was truncated to fit the MCP response budget. The persisted draft body is unchanged.'),
  bodyHtmlTruncated: z.boolean().optional()
    .describe('True if preview.bodyHtml was truncated to fit the MCP response budget. The persisted draft body is unchanged.'),
});

export const PreviewErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type DraftPreview = z.infer<typeof DraftPreviewSchema>;
export type PreviewError = z.infer<typeof PreviewErrorSchema>;

export interface BuildDraftPreviewResult {
  preview?: DraftPreview;
  previewError?: PreviewError;
}

// Cut a string to a UTF-8 byte budget without producing invalid sequences.
// Unlike truncateBody in body-loader.ts, this is for MCP tool-response sizing,
// not provider-side email size limits — so we deliberately do NOT append the
// "exceeded email size limits" notice (that would mislead an agent into
// thinking the persisted draft itself was capped). Truncation is signalled
// structurally via bodyTruncated / bodyHtmlTruncated in DraftPreviewSchema.
function truncateForPreview(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(input, 'utf-8');
  if (encoded.length <= maxBytes) return { text: input, truncated: false };

  // Walk back to a safe UTF-8 boundary so we don't return a half-codepoint.
  let cut = maxBytes;
  while (cut > 0 && (encoded[cut]! & 0xc0) === 0x80) cut--;

  return { text: encoded.subarray(0, cut).toString('utf-8'), truncated: true };
}

function toPreviewError(err: unknown): PreviewError {
  if (err instanceof ProviderError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: 'PREVIEW_FETCH_FAILED', message: err.message };
  }
  return { code: 'PREVIEW_FETCH_FAILED', message: String(err) };
}

/**
 * Build a preview block by reading the persisted draft back from the provider.
 *
 * The preview reflects PERSISTED state, not caller input — that is the point.
 * It surfaces persistence-layer drops (e.g. Microsoft Graph createDraft cc/bcc
 * drop, tracked in #48) without callers needing a separate read_email round
 * trip. See issue #75.
 *
 * On read-back failure, returns `{ previewError }` so the caller can surface
 * a structured signal to the agent — distinguishing "no preview" from
 * "preview lookup failed". The underlying create/update is still reported as
 * successful by the caller. A single short retry handles transient
 * read-after-write windows; non-recoverable ProviderErrors skip the retry.
 *
 * Note on cost: Gmail's updateDraft already does an internal getMessage to
 * merge partial updates (see GmailEmailProvider.updateDraft), so wiring this
 * helper after updateDraft on Gmail incurs a second redundant GET. Provider
 * interface changes to surface the persisted draft directly are out of scope
 * for v1; documented here so future optimizations have a starting point.
 */
export async function buildDraftPreview(
  provider: Pick<EmailReader, 'getMessage'>,
  draftId: string,
  opts?: { retryDelayMs?: number },
): Promise<BuildDraftPreviewResult> {
  const retryDelay = opts?.retryDelayMs ?? PREVIEW_RETRY_DELAY_MS;

  let persisted;
  try {
    persisted = await provider.getMessage(draftId);
  } catch (firstErr) {
    // Skip retry on definitively-permanent failures (e.g. invalid draft id).
    if (firstErr instanceof ProviderError && !firstErr.recoverable) {
      return { previewError: toPreviewError(firstErr) };
    }
    if (retryDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
    try {
      persisted = await provider.getMessage(draftId);
    } catch (secondErr) {
      return { previewError: toPreviewError(secondErr) };
    }
  }

  const preview: DraftPreview = {
    to: persisted.to,
    cc: persisted.cc,
    subject: persisted.subject,
  };
  if (persisted.body !== undefined) {
    const { text, truncated } = truncateForPreview(persisted.body, PREVIEW_BODY_LIMIT);
    preview.body = text;
    if (truncated) preview.bodyTruncated = true;
  }
  if (persisted.bodyHtml !== undefined) {
    const { text, truncated } = truncateForPreview(persisted.bodyHtml, PREVIEW_BODY_LIMIT);
    preview.bodyHtml = text;
    if (truncated) preview.bodyHtmlTruncated = true;
  }
  return { preview };
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
