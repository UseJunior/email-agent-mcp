// Default OAuth broker URL.
//
// This is the production broker operated by UseJunior. Self-hosted
// users override it with --broker-url or AGENT_EMAIL_GMAIL_BROKER_URL.
// BYOK users (--client-id + --client-secret) bypass it entirely.
export const DEFAULT_GMAIL_BROKER_URL = 'https://oauth.usejunior.com';
