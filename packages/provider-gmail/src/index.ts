// @usejunior/provider-gmail — Gmail API email provider
export { GmailEmailProvider } from './email-gmail-provider.js';
export {
  GMAIL_OAUTH_SCOPES,
  GmailAuthManager,
  isGmailReauthError,
  formatGmailAuthError,
} from './auth.js';
export {
  listConfiguredGmailMailboxes,
  loadGmailMailboxMetadata,
  saveGmailMailboxMetadata,
  toFilesystemSafeKey,
  getConfigDir,
} from './config.js';
export type { GmailMailboxMetadata } from './config.js';
export { GoogleapisGmailClient } from './googleapis-client.js';
export { registerWatch, needsRenewal, pollHistory } from './push.js';
