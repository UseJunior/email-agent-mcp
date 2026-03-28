// @usejunior/email-core — Actions, content engine, security, and provider interfaces
export { EMAIL_ACTIONS } from './actions/registry.js';
export type { EmailAction, AllowlistConfig } from './actions/registry.js';
export type {
  EmailAddress,
  EmailMessage,
  EmailThread,
  EmailAttachment,
  ComposeMessage,
  SendResult,
  DraftResult,
  ListOptions,
  ReplyOptions,
} from './types.js';
export type {
  EmailReader,
  EmailSender,
  EmailSubscriber,
  EmailProvider,
  AuthManager,
} from './providers/provider.js';
export {
  isAllowedSender,
  loadReceiveAllowlist,
  getReceiveAllowlistPath,
} from './security/receive-allowlist.js';
export {
  isAllowedRecipient,
  loadSendAllowlist,
  getSendAllowlistPath,
  checkSendAllowlist,
  SendRateLimiter,
} from './security/send-allowlist.js';
export { htmlToMarkdown, transformEmailContent } from './content/sanitize.js';
export { sendEmailAction } from './actions/send.js';
export { replyToEmailAction } from './actions/reply.js';
