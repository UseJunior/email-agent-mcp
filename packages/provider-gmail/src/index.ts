// @usejunior/provider-gmail — Gmail API email provider
export { GmailEmailProvider } from './email-gmail-provider.js';
export {
  GMAIL_OAUTH_SCOPES,
  GmailAuthManager,
  isGmailReauthError,
  formatGmailAuthError,
} from './auth.js';
export type {
  GmailAuthMode,
  GmailAuthConfig,
  GmailBrokerSession,
  GmailPickUpOptions,
  GmailProfile,
  GmailAuthUrlOptions,
  GmailExchangeCodeOptions,
} from './auth.js';
export { DEFAULT_GMAIL_BROKER_URL } from './broker.js';
export {
  listConfiguredGmailMailboxes,
  loadGmailMailboxMetadata,
  saveGmailMailboxMetadata,
  toFilesystemSafeKey,
  getConfigDir,
} from './config.js';
export type { GmailMailboxMetadata, GmailAuthSource } from './config.js';
export { GoogleapisGmailClient } from './googleapis-client.js';
export { registerWatch, needsRenewal, pollHistory } from './push.js';
