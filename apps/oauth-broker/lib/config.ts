// Centralized env config. Fail fast if required vars are missing.

export interface BrokerConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  ticketTtlMs: number;
  // Single-tenant prototype lives without KV (in-memory store).
  // Production deployments must configure Vercel KV.
  useKv: boolean;
  brokerOrigin: string;
}

let cached: BrokerConfig | null = null;

export function getConfig(): BrokerConfig {
  if (cached) return cached;

  const clientId = required('GMAIL_OAUTH_CLIENT_ID');
  const clientSecret = required('GMAIL_OAUTH_CLIENT_SECRET');
  const brokerOrigin = required('BROKER_PUBLIC_ORIGIN');
  const redirectUri = `${brokerOrigin}/api/callback`;

  cached = {
    clientId,
    clientSecret,
    redirectUri,
    scopes: (process.env['GMAIL_OAUTH_SCOPES'] ?? 'https://mail.google.com/').split(/\s+/).filter(Boolean),
    ticketTtlMs: Number(process.env['BROKER_TICKET_TTL_MS'] ?? 5 * 60 * 1000),
    useKv: process.env['KV_REST_API_URL'] !== undefined,
    brokerOrigin,
  };
  return cached;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
