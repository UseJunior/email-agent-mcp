// @usejunior/email-core — Actions, content engine, security, and provider interfaces
export { EMAIL_ACTIONS } from './actions/registry.js';
export type { EmailAction, AllowlistConfig } from './actions/registry.js';
export type {
  EmailAddress,
  EmailMessage,
  EmailThread,
  EmailAttachment,
  ComposeMessage,
  OutboundAttachment,
  SendResult,
  DraftResult,
  EmailError,
  ListOptions,
  ReplyOptions,
} from './types.js';
export type {
  EmailReader,
  EmailSender,
  EmailSubscriber,
  EmailCategorizer,
  EmailAttachmentHandler,
  EmailFolder,
  EmailFolderManager,
  InboxRule,
  CreateInboxRule,
  EmailRuleManager,
  DownloadedAttachment,
  EmailProvider,
  AuthManager,
} from './providers/provider.js';
export { ProviderError, AttachmentNotSupportedError, AttachmentNotFoundError } from './providers/provider.js';
export {
  isAllowedSender,
  loadReceiveAllowlist,
  getReceiveAllowlistPath,
  checkDeletePolicy,
  getDeletePolicyFromEnv,
} from './security/receive-allowlist.js';
export type { DeletePolicy } from './security/receive-allowlist.js';
export {
  isAllowedRecipient,
  loadSendAllowlist,
  getSendAllowlistPath,
  checkSendAllowlist,
  SendRateLimiter,
} from './security/send-allowlist.js';
export { WatchedAllowlist } from './security/watched-allowlist.js';
export { htmlToMarkdown, transformEmailContent } from './content/sanitize.js';
export { readEmailAction } from './actions/read.js';
export { sendEmailAction } from './actions/send.js';
export {
  EmailThreadFieldsSchema,
  getEmailThreadFields,
  SearchEmailThreadFieldsSchema,
  getSearchEmailThreadFields,
} from './actions/search.js';
export { replyToEmailAction } from './actions/reply.js';
export { createDraftAction, sendDraftAction, updateDraftAction } from './actions/draft.js';
export { getThreadAction } from './actions/conversation.js';
export { listAttachmentsAction, downloadAttachmentAction } from './actions/attachments.js';
export { labelEmailAction, flagEmailAction, markReadAction, deleteEmailAction } from './actions/label.js';
export { moveToFolderAction } from './actions/move.js';
export {
  listFoldersAction, // list_folders
  createFolderAction, // create_folder
  deleteFolderAction, // delete_folder
} from './actions/folders.js';
export {
  listInboxRulesAction, // list_inbox_rules
  createInboxRuleAction, // create_inbox_rule
  deleteInboxRuleAction, // delete_inbox_rule
} from './actions/rules.js';
export { parseFrontmatter } from './content/frontmatter.js';
export type { FrontmatterFields } from './content/frontmatter.js';
export { resolveBodyFile, truncateBody, BODY_SIZE_LIMIT } from './content/body-loader.js';
export {
  checkMailboxRequired,
  resolveComposeFields,
  validateRequiredFields,
  checkRateLimit,
  handleProviderError,
} from './actions/compose-helpers.js';
export { isPlausibleMessageId, checkReplyThreading } from './security/reply-validation.js';
