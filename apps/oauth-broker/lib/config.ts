// Centralized env config. Fail fast if required vars are missing.

export interface BrokerConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  ticketTtlMs: number;
  /** Use Vercel KV / Upstash Redis when true. False = in-memory (dev only). */
  useKv: boolean;
  brokerOrigin: string;
  /** When true (default in prod), refuse to start with the in-memory store. */
  requireKv: boolean;
}

let cached: BrokerConfig | null = null;

export function getConfig(): BrokerConfig {
  if (cached) return cached;

  const clientId = required('GMAIL_OAUTH_CLIENT_ID');
  const clientSecret = required('GMAIL_OAUTH_CLIENT_SECRET');
  const brokerOrigin = required('BROKER_PUBLIC_ORIGIN');
  const redirectUri = `${brokerOrigin}/api/callback`;

  const useKv = process.env['KV_REST_API_URL'] !== undefined;
  // Vercel sets VERCEL_ENV to 'production' | 'preview' | 'development'.
  // BROKER_REQUIRE_KV explicitly overrides for cases like ephemeral preview
  // environments that intentionally run without a Redis attachment.
  const requireKv =
    process.env['BROKER_REQUIRE_KV'] === 'true' ||
    (process.env['BROKER_REQUIRE_KV'] !== 'false' && process.env['VERCEL_ENV'] === 'production');

  if (requireKv && !useKv) {
    throw new Error(
      'Broker is configured to require Redis (BROKER_REQUIRE_KV=true or VERCEL_ENV=production) but KV_REST_API_URL is not set. ' +
      'Attach a Redis instance via the Vercel Marketplace (Upstash or Vercel-managed Redis) before deploying.',
    );
  }

  cached = {
    clientId,
    clientSecret,
    redirectUri,
    scopes: (
      process.env['GMAIL_OAUTH_SCOPES'] ??
      'https://www.googleapis.com/auth/gmail.modify'
    ).split(/\s+/).filter(Boolean),
    ticketTtlMs: Number(process.env['BROKER_TICKET_TTL_MS'] ?? 5 * 60 * 1000),
    useKv,
    brokerOrigin,
    requireKv,
  };
  return cached;
}

/** Test helper: clear cached config so the next getConfig() re-reads env. */
export function _resetConfigForTests(): void {
  cached = null;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
