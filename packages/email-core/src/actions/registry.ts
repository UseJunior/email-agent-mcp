// Action registry — single source of truth for all email actions
import { z } from 'zod';
import type { EmailProvider } from '../providers/provider.js';
import { listAttachmentsAction, downloadAttachmentAction } from './attachments.js';
import { configureMailboxAction, removeMailboxAction, listMailboxesAction } from './configure.js';
import { getThreadAction } from './conversation.js';
import { createDraftAction, sendDraftAction, updateDraftAction } from './draft.js';
import { listFoldersAction, createFolderAction, deleteFolderAction } from './folders.js';
import { labelEmailAction, flagEmailAction, markReadAction, deleteEmailAction } from './label.js';
import { listEmailsAction } from './list.js';
import { moveToFolderAction } from './move.js';
import { readEmailAction } from './read.js';
import { replyToEmailAction } from './reply.js';
import { listInboxRulesAction, createInboxRuleAction, deleteInboxRuleAction } from './rules.js';
import { cancelScheduledSendAction, listScheduledSendsAction } from './scheduling.js';
import { searchEmailsAction } from './search.js';
import { sendEmailAction } from './send.js';
import { getMailboxStatusAction } from './status.js';

export interface ActionContext {
  provider: EmailProvider;
  mailboxName?: string;
  allMailboxes?: MailboxEntry[];
  sendAllowlist?: AllowlistConfig;
  receiveAllowlist?: AllowlistConfig;
  safeDir?: string;
  deleteEnabled?: boolean;
  hardDeleteAllowed?: boolean;
  rateLimiter?: RateLimiter;
}

export interface MailboxEntry {
  name: string;
  emailAddress?: string;
  provider: EmailProvider;
  providerType: string;
  isDefault: boolean;
  status: 'connected' | 'disconnected' | 'error';
}

export interface AllowlistConfig {
  entries: string[]; // e.g., ["*@example.com", "alice@test.com", "*"]
}

export interface RateLimiter {
  checkLimit(action: string): { allowed: boolean; retryAfter?: number };
  recordUsage(action: string): void;
}

export interface EmailAction<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  run: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}

// Canonical, explicit list of every email action defined in this package.
// Deliberately NOT side-effect registration (a previous mutable
// `registerAction()` mechanism was never called, leaving this array
// permanently empty — see issue #174): an explicit list is ordering-safe,
// tree-shake-safe, and testable. Adding a new action module means adding it
// here; `registry.test.ts` enforces that the list stays complete and
// duplicate-free.
export const EMAIL_ACTIONS: readonly EmailAction<any, any>[] = [
  // Read / list / search
  listEmailsAction,
  readEmailAction,
  searchEmailsAction,
  getThreadAction,
  // Compose / send
  sendEmailAction,
  replyToEmailAction,
  createDraftAction,
  sendDraftAction,
  updateDraftAction,
  cancelScheduledSendAction,
  listScheduledSendsAction,
  // Attachments
  listAttachmentsAction,
  downloadAttachmentAction,
  // Triage
  labelEmailAction,
  flagEmailAction,
  markReadAction,
  deleteEmailAction,
  moveToFolderAction,
  // Folders
  listFoldersAction,
  createFolderAction,
  deleteFolderAction,
  // Inbox rules
  listInboxRulesAction,
  createInboxRuleAction,
  deleteInboxRuleAction,
  // Mailbox management / status
  configureMailboxAction,
  removeMailboxAction,
  listMailboxesAction,
  getMailboxStatusAction,
];
