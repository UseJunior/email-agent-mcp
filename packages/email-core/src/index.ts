// @usejunior/email-core — Actions, content engine, security, and provider interfaces
export { EMAIL_ACTIONS } from './actions/registry.js';
export type { EmailAction } from './actions/registry.js';
export type {
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
} from './providers/provider.js';
