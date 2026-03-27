// @usejunior/provider-microsoft — Microsoft Graph API email provider
export { GraphEmailProvider } from './email-graph-provider.js';
export { DelegatedAuthManager, ClientCredentialsAuthManager } from './auth.js';
export {
  handleValidationToken,
  isDuplicateNotification,
  checkSubscriptionExists,
  healthCheckEndpoint,
  createInboxSubscription,
} from './subscriptions.js';
