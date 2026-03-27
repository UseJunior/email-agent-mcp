// @usejunior/provider-microsoft — Microsoft Graph API email provider
export { GraphEmailProvider, RealGraphApiClient, GraphApiError, type GraphApiClient } from './email-graph-provider.js';
export { DelegatedAuthManager, ClientCredentialsAuthManager, listConfiguredMailboxes, loadMailboxMetadata, GRAPH_SCOPES } from './auth.js';
export {
  handleValidationToken,
  isDuplicateNotification,
  checkSubscriptionExists,
  healthCheckEndpoint,
  createInboxSubscription,
} from './subscriptions.js';
