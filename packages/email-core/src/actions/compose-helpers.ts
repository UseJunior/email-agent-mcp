// Shared helpers for compose actions — internal module, NOT exported from package root
import { z } from 'zod';
import { basename } from 'node:path';
import type { RateLimiter, MailboxEntry, ActionContext } from './registry.js';
import { adaptLegacyRateLimiter } from '../security/rate-reservation.js';
import { isProviderError } from '../providers/provider.js';
import type { EmailReader } from '../providers/provider.js';
import { resolveBodyFile } from '../content/body-loader.js';
import { MAX_ATTACHMENT_SIZE, resolveAttachmentFile } from '../content/attachment-loader.js';
import type { PathSandboxInput } from '../content/safe-path.js';
import type { BodyFormat, ListStyle } from '../content/body-renderer.js';
import { LIST_STYLES } from '../content/body-renderer.js';
import { findNestedListReorderHazards } from '../content/outlook-list-hazards.js';
import { parseAddressList } from '../utils/address.js';
import { validateAttachment, sanitizeFilename } from './attachments.js';
import {
  computeSendFingerprint,
  duplicateSendError,
  getDefaultSendLedger,
  providerNamespace,
  isDeliveryProvenUnsent,
} from '../security/send-ledger.js';
import type { SendClaim, SendFingerprintInput } from '../security/send-ledger.js';
import type { EmailAddress, EmailMessage, OutboundAttachment } from '../types.js';

// --- Error shape used by all actions ---

interface ActionError {
  code: string;
  message: string;
  recoverable: boolean;
  // Set only on MAILBOX_REQUIRED: the mailbox names accepted by the `mailbox`
  // selector, so a caller can recover in a single retry without a discovery
  // round trip. Reflects the mailboxes available for dispatch (connected at the
  // MCP wrapper), not necessarily every mailbox on disk.
  availableMailboxes?: string[];
  defaultMailbox?: string;
  retryAfter?: number;
}

/**
 * The filesystem sandbox for caller-supplied paths on this request: the safe
 * base directory plus any operator-allowlisted extra roots.
 */
export function pathSandbox(ctx: ActionContext): PathSandboxInput {
  return { safeDir: ctx.safeDir, allowedDirs: ctx.allowedDirs };
}

// --- checkMailboxRequired ---

export function checkMailboxRequired(
  mailbox: string | undefined,
  allMailboxes: MailboxEntry[] | undefined,
): ActionError | null {
  if (!mailbox && allMailboxes && allMailboxes.length > 1) {
    const defaultMailbox = allMailboxes.find(m => m.isDefault)?.name;
    return {
      code: 'MAILBOX_REQUIRED',
      message: 'mailbox parameter required when multiple mailboxes are configured',
      recoverable: true,
      availableMailboxes: allMailboxes.map(m => m.name),
      ...(defaultMailbox !== undefined ? { defaultMailbox } : {}),
    };
  }
  return null;
}

// --- resolveComposeFields ---

export interface ComposeFields {
  body: string;
  to?: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  replyTo?: string;
  draft?: boolean;
  format?: BodyFormat;
  forceBlack?: boolean;
  listStyle?: ListStyle;
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
    bcc?: string[];
    subject?: string;
    reply_to?: string;
    draft?: boolean;
    format?: BodyFormat;
    force_black?: boolean;
    list_style?: ListStyle;
  },
  sandbox?: PathSandboxInput,
  opts?: { bodyOptional?: boolean },
): Promise<ComposeFields> {
  let body: string | undefined;
  let to = input.to;
  let cc = input.cc;
  let bcc = input.bcc;
  let subject = input.subject;
  let replyTo = input.reply_to;
  let draft = input.draft;
  let format = input.format;
  let forceBlack = input.force_black;
  let listStyle = input.list_style;

  if (input.body_file) {
    const bodyResult = await resolveBodyFile(input.body_file, sandbox);
    if (bodyResult.error) {
      return { body: '', error: bodyResult.error };
    }
    body = bodyResult.content!;

    // Frontmatter is authoritative
    if (bodyResult.frontmatter) {
      const fm = bodyResult.frontmatter;
      if (fm.to !== undefined) to = fm.to;
      if (fm.cc !== undefined) cc = Array.isArray(fm.cc) ? fm.cc : [fm.cc];
      if (fm.bcc !== undefined) bcc = Array.isArray(fm.bcc) ? fm.bcc : [fm.bcc];
      if (fm.subject !== undefined) subject = fm.subject;
      if (fm.reply_to !== undefined) replyTo = fm.reply_to;
      if (fm.draft !== undefined) draft = fm.draft;
      if (fm.format !== undefined) format = fm.format;
      if (fm.force_black !== undefined) forceBlack = fm.force_black;
      if (fm.list_style !== undefined) listStyle = fm.list_style;
    }
  } else if (input.body) {
    body = input.body;
  } else if (!opts?.bodyOptional) {
    return {
      body: '',
      error: { code: 'MISSING_BODY', message: 'Either body or body_file is required', recoverable: false },
    };
  }

  return { body: body ?? '', to, cc, bcc, subject, replyTo, draft, format, forceBlack, listStyle };
}

// --- Body rendering options ---

/**
 * `list_style` on every compose action that renders a markdown body. Shared so
 * the four tool schemas cannot drift apart.
 */
export const ListStyleSchema = z.enum(LIST_STYLES as [ListStyle, ...ListStyle[]])
  .describe(
    "Ordered-list shaping for markdown bodies. 'default' (the default) is standard markdown rendering. "
    + "'outlook' emits numbered items that carry sub-paragraphs (for example lettered points a., b. under "
    + 'each number) in the shape Outlook\'s own editor saves: the numbered list is split around the '
    + 'sub-paragraphs, which follow outside the list as <p style="margin-left:80px">, and each later '
    + 'segment is <ol start="N"> so numbering continues. Use it when the recipient will edit the message in '
    + 'Outlook: Tab on a sub-paragraph then indents it instead of demoting the numbered item above and '
    + 'renumbering the list. Either markdown habit works: sub-paragraphs indented under their item, or '
    + 'unindented between items whose numbers continue (1., then 2.). A paragraph that follows a nested '
    + 'list inside an item (numbered or bulleted) is moved out after the list the same way, because '
    + "Outlook's editor otherwise moves it above the nested list. Other bullet lists, items with no "
    + "sub-paragraphs, and items ending in a nested list are unchanged. Ignored when format is 'html' or 'text'.",
  );

// --- Warnings ---

/** A non-fatal note on a successful (or attempted) compose call. */
export const ActionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ActionWarning = z.infer<typeof ActionWarningSchema>;

/** The defined warnings, or undefined when there are none (so the field can be omitted). */
export function collectWarnings(...candidates: Array<ActionWarning | undefined>): ActionWarning[] | undefined {
  const warnings = candidates.filter((w): w is ActionWarning => w !== undefined);
  return warnings.length > 0 ? warnings : undefined;
}

const HAZARD_LIST_LIMIT = 3;

/**
 * Warn when the HTML a compose call stores or sends holds content after a
 * nested list inside the same `<li>`, which Outlook's compose editor moves
 * above the nested list when the message is opened for editing (issue #227).
 * The HTML is never rewritten here — for `format: 'html'` the caller owns the
 * markup — so the warning says how to fix it at the source.
 *
 * Pass the HTML exactly as it goes to the provider (after truncation). The
 * check is advisory: if analysis fails for any reason, no warning is returned
 * and the compose call proceeds.
 */
export function outlookNestedListWarning(
  bodyHtml: string | undefined,
  format: BodyFormat | undefined,
  listStyle: ListStyle | undefined,
): ActionWarning | undefined {
  if (bodyHtml === undefined) return undefined;
  let hazards: string[];
  try {
    hazards = findNestedListReorderHazards(bodyHtml);
  } catch (err) {
    console.error(`[email-core] nested-list check skipped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (hazards.length === 0) return undefined;
  const shown = hazards.slice(0, HAZARD_LIST_LIMIT).map(h => `"${h}"`).join(', ');
  const more = hazards.length > HAZARD_LIST_LIMIT ? ` and ${hazards.length - HAZARD_LIST_LIMIT} more` : '';
  const where = `${hazards.length} list item${hazards.length === 1 ? '' : 's'} (${shown}${more})`;
  let fix: string;
  if (format === 'html') {
    fix = 'This HTML is passed through unchanged. To keep the order, close the <li> after its nested list and put the '
      + 'following content after the enclosing list, e.g. as <p style="margin-left:80px">, then reopen the '
      + 'list (with <ol start="N"> to continue numbering).';
  } else if (listStyle === 'outlook') {
    fix = "list_style 'outlook' moves out only paragraphs that follow a single nested list in a top-level item; "
      + 'restructure these items (for example, end the item at its nested list and continue in a new paragraph).';
  } else {
    fix = "Pass list_style: 'outlook' to move paragraphs that follow a nested list out of the item in the shape "
      + 'Outlook keeps.';
  }
  return {
    code: 'OUTLOOK_NESTED_LIST_REORDER',
    message: `In ${where}, content follows a nested list inside the same <li>. Outlook's compose editor moves `
      + 'that content above the nested list when the message is opened for editing, and saves it in that order. '
      + fix,
  };
}

// --- Outbound attachments ---

// Strict standard-base64: zero or more full quartets, then an optional final
// group of 2 chars + `==` or 3 chars + `=`. Rejects lengths that are not a
// valid base64 size (e.g. a lone `A` or `abcde`), which Node's decoder would
// otherwise silently truncate into corrupt bytes.
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const hasNonEmpty = (v: string | undefined): boolean => v !== undefined && v !== '';

/** True when `value` (whitespace stripped) is non-empty, valid standard base64. */
function isValidBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, '');
  return stripped.length > 0 && BASE64_PATTERN.test(stripped);
}

/**
 * Per-attachment input schema for the four outbound actions. Each entry takes
 * a sandboxed file path OR inline base64 — exactly one — plus optional
 * filename/mimeType overrides.
 */
export const AttachmentInputSchema = z
  .object({
    path: z.string().optional()
      .describe('Path to a file, sandboxed like body_file. Relative paths resolve against the working directory only; files in a directory the operator allowlisted via AGENT_EMAIL_ALLOWED_DIRS must be given as an ABSOLUTE path (a leading ~ is not expanded here).'),
    base64: z.string().optional()
      .describe('Inline standard-base64-encoded file content, maximum 25 MB decoded. Alternative to path.'),
    filename: z.string().optional()
      .describe('Attachment filename. Defaults to basename(path); REQUIRED when using base64.'),
    mimeType: z.string().optional()
      .describe('Optional MIME type hint. Overrides ZIP-container extension inference (Office/ODF documents are recognized without it); recognized JPEG/PNG/GIF/PDF magic bytes remain authoritative.'),
  })
  .refine(v => hasNonEmpty(v.path) !== hasNonEmpty(v.base64), {
    message: 'Each attachment must set exactly one of `path` or `base64`.',
  })
  .refine(v => !(hasNonEmpty(v.base64) && !hasNonEmpty(v.path) && !hasNonEmpty(v.filename)), {
    message: '`filename` is required when an attachment is provided as `base64`.',
  })
  .refine(
    v => !(hasNonEmpty(v.base64) && !hasNonEmpty(v.path)) || isValidBase64(v.base64!),
    { message: '`base64` is not valid standard base64.' },
  );

export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export interface ResolveAttachmentsResult {
  files?: OutboundAttachment[];
  error?: ActionError;
}

/**
 * Resolve caller-supplied attachment inputs into validated OutboundAttachment
 * buffers. Path entries are read sandboxed to `sandbox`; base64 entries are
 * decoded inline. Each file is run through validateAttachment (25MB cap +
 * magic-byte MIME). Returns a structured error on the first failure — never
 * throws. An undefined/empty input yields `{ files: [] }`.
 */
export async function resolveAttachments(
  attachments: AttachmentInput[] | undefined,
  sandbox: PathSandboxInput,
): Promise<ResolveAttachmentsResult> {
  if (!attachments || attachments.length === 0) {
    return { files: [] };
  }

  const files: OutboundAttachment[] = [];
  for (const [index, att] of attachments.entries()) {
    let content: Buffer;
    let defaultName: string;

    if (hasNonEmpty(att.path)) {
      const read = await resolveAttachmentFile(att.path!, sandbox);
      if (read.error) {
        return { error: { ...read.error, message: `attachments[${index}]: ${read.error.message}` } };
      }
      content = read.content!;
      defaultName = basename(att.path!);
    } else {
      content = Buffer.from(att.base64!.replace(/\s/g, ''), 'base64');
      defaultName = 'attachment';
    }

    const filename = sanitizeFilename(att.filename ?? defaultName);
    if (content.length > MAX_ATTACHMENT_SIZE) {
      return {
        error: {
          code: 'ATTACHMENT_TOO_LARGE',
          message: `attachments[${index}]: Attachment exceeds maximum size of 25MB`,
          recoverable: false,
        },
      };
    }
    const validation = validateAttachment(content, filename, att.mimeType);
    if (!validation.valid) {
      return {
        error: {
          code: 'ATTACHMENT_INVALID',
          message: `attachments[${index}]: ${validation.error}`,
          recoverable: false,
        },
      };
    }

    files.push({ filename, content, mimeType: validation.detectedMimeType });
  }

  return { files };
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

/** @deprecated Observation only; delivery actions reserve through claimDelivery. */
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
  | { to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] }
  | { error: ActionError };

export function parseRecipients(
  input: { to?: string[]; cc?: string[]; bcc?: string[] },
): ParsedRecipients {
  const lists: Record<'to' | 'cc' | 'bcc', EmailAddress[]> = { to: [], cc: [], bcc: [] };
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const result = parseAddressList(input[field], field);
    if (!result.ok) {
      return {
        error: {
          code: 'INVALID_ADDRESS',
          message: `${result.field}[${result.index}] invalid address: "${result.value}"`,
          recoverable: false,
        },
      };
    }
    lists[field] = result.addresses;
  }
  return lists;
}

/** Bcc addresses that also appear on To or Cc, compared case-insensitively. */
function bccOverlap(
  recipients: { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] },
): string[] {
  const visible = new Set([...(recipients.to ?? []), ...(recipients.cc ?? [])].map(a => a.email.toLowerCase()));
  return (recipients.bcc ?? []).filter(a => visible.has(a.email.toLowerCase())).map(a => a.email);
}

/**
 * Reject a compose call that names the same address on Bcc and on To or Cc.
 * Bcc exists to hide a recipient from the others; listing them visibly too
 * defeats that silently, so the caller must pick one (issue #214).
 */
export function checkBccOverlap(
  recipients: { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] },
): ActionError | null {
  const overlap = bccOverlap(recipients);
  if (overlap.length === 0) return null;
  return {
    code: 'BCC_RECIPIENT_CONFLICT',
    message: `Listed on bcc and also on to/cc: ${overlap.join(', ')}. Name each recipient on one line only.`,
    recoverable: true,
  };
}

/**
 * Warn when a persisted draft still shows a Bcc recipient on To or Cc — e.g.
 * update_draft set bcc without restating the draft's existing To/Cc.
 */
export function bccVisibleWarning(
  preview: DraftPreview | undefined,
): { code: string; message: string } | undefined {
  const overlap = preview ? bccOverlap(preview) : [];
  if (overlap.length === 0) return undefined;
  return {
    code: 'BCC_RECIPIENT_ALSO_VISIBLE',
    message: `The draft lists ${overlap.join(', ')} on bcc and also on to/cc, so they are not hidden. Restate to/cc without them to keep the bcc hidden.`,
  };
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
  // bcc is surfaced from the provider read-back: both Gmail's mapGmailMessage and
  // Graph's mapGraphMessage now parse bcc on the sender's own copy (issue #102),
  // so a draft preview can report the full recipient topology it will send with.
  bcc: z.array(EmailAddressSchema).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  bodyHtml: z.string().optional(),
  bodyTruncated: z.boolean().optional()
    .describe('True if preview.body was truncated to fit the MCP response budget. The persisted draft body is unchanged.'),
  bodyHtmlTruncated: z.boolean().optional()
    .describe('True if preview.bodyHtml was truncated to fit the MCP response budget. The persisted draft body is unchanged.'),
  quotedHistoryOmitted: z.boolean().optional()
    .describe('True only when preview.bodyHtml omits provider-assembled quoted history. The persisted draft body is unchanged.'),
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
//
// Exported so read.ts can reuse the identical byte-safe cut for its raw-HTML
// body — one implementation, so the two truncation signals can never disagree
// about where a multi-byte codepoint boundary is.
export function truncateForPreview(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(input, 'utf-8');
  if (encoded.length <= maxBytes) return { text: input, truncated: false };

  // Walk back to a safe UTF-8 boundary so we don't return a half-codepoint.
  let cut = maxBytes;
  while (cut > 0 && (encoded[cut]! & 0xc0) === 0x80) cut--;

  return { text: encoded.subarray(0, cut).toString('utf-8'), truncated: true };
}

function toPreviewError(err: unknown): PreviewError {
  if (isProviderError(err)) {
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
 * Providers may expose a draft-specific read path when their API uses distinct
 * identifiers for draft resources and their backing messages (as Gmail does).
 */
export async function buildDraftPreview(
  provider: Pick<EmailReader, 'getMessage' | 'getDraft'>,
  draftId: string,
  opts?: { retryDelayMs?: number; authoredOnly?: boolean },
): Promise<BuildDraftPreviewResult> {
  const retryDelay = opts?.retryDelayMs ?? PREVIEW_RETRY_DELAY_MS;
  const readDraft = (): Promise<EmailMessage> => provider.getDraft?.(draftId)
    ?? provider.getMessage(draftId);

  let persisted;
  try {
    persisted = await readDraft();
  } catch (firstErr) {
    // Skip retry on definitively-permanent failures (e.g. invalid draft id).
    // Deliberately NOT switched to the operation-aware isRetryable policy: this
    // is a read-after-write against a draft the provider has just persisted, so
    // retrying an unclassified failure (a plain Error, a lost response) is the
    // right behaviour here and is covered by draft.test.ts.
    if (isProviderError(firstErr) && !firstErr.recoverable) {
      return { previewError: toPreviewError(firstErr) };
    }
    if (retryDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
    try {
      persisted = await readDraft();
    } catch (secondErr) {
      return { previewError: toPreviewError(secondErr) };
    }
  }

  const preview: DraftPreview = {
    to: persisted.to,
    cc: persisted.cc,
    bcc: persisted.bcc,
    subject: persisted.subject,
  };
  if (persisted.body !== undefined) {
    const { text, truncated } = truncateForPreview(persisted.body, PREVIEW_BODY_LIMIT);
    preview.body = text;
    if (truncated) preview.bodyTruncated = true;
  }
  const useAuthoredBody = opts?.authoredOnly === true
    && persisted.authoredBodyHtml !== undefined
    && persisted.authoredBodyHtml !== persisted.bodyHtml;
  const previewBodyHtml = useAuthoredBody
    ? persisted.authoredBodyHtml
    : persisted.bodyHtml;
  if (previewBodyHtml !== undefined) {
    const { text, truncated } = truncateForPreview(previewBodyHtml, PREVIEW_BODY_LIMIT);
    preview.bodyHtml = text;
    if (truncated) preview.bodyHtmlTruncated = true;
    if (useAuthoredBody) preview.quotedHistoryOmitted = true;
  }
  return { preview };
}

// --- handleProviderError ---

/**
 * Convert a thrown provider error into an action result.
 *
 * `retryAfter` is preserved when the provider supplied one, so a throttled
 * caller learns how long to wait. `provider` is deliberately NOT surfaced: the
 * caller already chose the mailbox, so it adds a field to keep in sync across
 * four output schemas in exchange for no decision.
 *
 * `fallbackCode` is used only for errors the provider did not classify. For
 * delivery operations that fallback MUST be SEND_STATUS_UNKNOWN, not a terminal
 * code — see the delivery actions. An unclassified failure on a send is exactly
 * the case where we cannot prove the message was not delivered.
 */
export function handleProviderError(err: unknown, fallbackCode: string) {
  if (isProviderError(err)) {
    return {
      success: false as const,
      error: {
        code: err.code,
        message: err.message,
        recoverable: err.recoverable,
        ...(typeof err.retryAfter === 'number' ? { retryAfter: err.retryAfter } : {}),
      },
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

// --- claimDelivery ---

/**
 * The deliberate-duplicate escape hatch, shared by every delivery action.
 *
 * Worded for the agent reading the tool schema: the guard exists because an
 * agent replaying a lost turn is the common case, so the flag has to read as a
 * human decision rather than a retry knob.
 */
export const AllowDuplicateSchema = z.boolean()
  .describe('Bypass the duplicate-delivery guard for this request. The guard refuses an identical delivery repeated within the duplicate window (default 15 minutes) so a replayed tool call cannot send the same message twice. Set true ONLY when a person has decided to deliberately send the same message again — never as a way to retry a call that failed.');

export type DeliveryClaim =
  | { claim: SendClaim }
  | { duplicate: { success: false; messageId?: string; error: ActionError } };

/**
 * Reserve this delivery in the send ledger before touching the provider.
 *
 * Compose/reply claim after preflight gates; draft sending claims the input ID
 * before lookup and the canonical ID after lookup if distinct. Release preflight
 * refusals, markDispatched immediately before provider invocation, then settle
 * every outcome (including throws). Live leases never age out automatically.
 * Rate capacity follows this lease's terminal outcome. Canonical aliases pass
 * reserveRate=false because the input-ID lease already owns their capacity.
 *
 * On a collision the prior attempt's `messageId` is surfaced at the top level
 * even though `success` is false: the caller asked whether this message went
 * out, and the honest answer includes which message it already is.
 */
export function claimDelivery(
  ctx: ActionContext,
  actionName: string,
  fingerprintInput: Omit<SendFingerprintInput, 'action' | 'mailbox'>,
  allowDuplicate: boolean | undefined,
  reserveRate = true,
): DeliveryClaim {
  const ledger = ctx.sendLedger ?? getDefaultSendLedger();
  // Namespace the fingerprint by mailbox. `mailboxName` is optional on
  // ActionContext, and two mailboxes sharing the process default ledger under
  // an empty key would collide — the second mailbox's first send refused, and
  // handed the first mailbox's message id. Fall back to the provider instance.
  const fingerprint = computeSendFingerprint({
    ...fingerprintInput,
    action: actionName,
    mailbox: ctx.mailboxName ?? providerNamespace(ctx.provider),
  });
  const result = ledger.claim(fingerprint, { force: allowDuplicate === true });
  if (result.ok) {
    if (!ctx.rateLimiter || !reserveRate) return { claim: result };
    let reservation;
    try {
      const limiter = 'tryReserve' in ctx.rateLimiter ? ctx.rateLimiter : adaptLegacyRateLimiter(ctx.rateLimiter);
      reservation = limiter.tryReserve(actionName);
    } catch (err) {
      result.release();
      throw err;
    }
    if (!reservation.allowed) {
      result.release();
      return { duplicate: { success: false, error: {
        code: 'RATE_LIMITED',
        message: `Send rate limit exceeded. Retry after ${reservation.retryAfter}s`,
        recoverable: true,
        ...(reservation.retryAfter !== undefined ? { retryAfter: reservation.retryAfter } : {}),
      } } };
    }
    const { lease } = reservation;
    let terminal = false;
    return { claim: {
      ok: true, fingerprint: result.fingerprint,
      get leaseState() { return result.leaseState; },
      markDispatched: () => result.markDispatched(),
      release: () => {
        if (terminal || result.leaseState !== 'reserved') return;
        terminal = true;
        result.release();
        lease.release();
      },
      settle: outcome => {
        if (terminal) return;
        terminal = true;
        result.settle(outcome);
        try {
          if (!outcome.success && isDeliveryProvenUnsent(outcome.errorCode)) lease.release();
          else lease.consume();
        } catch {
          // Bookkeeping cannot change provider evidence or interrupt sibling
          // canonical-draft settlement. Never print provider/client content.
          console.error('[email-agent-mcp] Rate reservation settlement failed');
        }
      },
    } };
  }
  return {
    duplicate: {
      success: false,
      ...(result.prior.messageId !== undefined ? { messageId: result.prior.messageId } : {}),
      error: duplicateSendError(result.prior, actionName),
    },
  };
}

/**
 * Settle a claim from a thrown provider error.
 *
 * Only a classified ProviderError carries a code we can reason about. An
 * unclassified throw is settled with no code at all, which the ledger holds as
 * unresolved — the fail-closed direction, because a throw after dispatch is
 * exactly the case where we cannot prove the message did not go out.
 */
export function settleClaimFromThrow(claim: SendClaim, err: unknown): void {
  claim.settle({
    success: false,
    ...(isProviderError(err) ? { errorCode: err.code } : {}),
  });
}
