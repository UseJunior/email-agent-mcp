// @usejunior/provider-microsoft — Microsoft Graph API email provider
export { GraphEmailProvider, RealGraphApiClient, GraphApiError, type GraphApiClient, type DeltaResult } from './email-graph-provider.js';
export { DelegatedAuthManager, ClientCredentialsAuthManager, listConfiguredMailboxes, listConfiguredMailboxesWithMetadata, loadMailboxMetadata, toFilesystemSafeKey, getConfigDir, GRAPH_SCOPES, GRAPH_SCOPES_BY_PROFILE, GRAPH_SCOPES_FULL_BY_PROFILE, isAuthError } from './auth.js';
export type { MailboxMetadata } from './auth.js';
export {
  handleValidationToken,
  isDuplicateNotification,
  checkSubscriptionExists,
  healthCheckEndpoint,
  createInboxSubscription,
} from './subscriptions.js';
