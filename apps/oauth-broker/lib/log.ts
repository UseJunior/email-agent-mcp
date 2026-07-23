// Broker request logging intentionally has zero imports so it stays safe to
// use from every Vercel function without pulling runtime-specific code into
// the logging path. Session correlation uses the first eight characters of a
// validated, high-entropy base64url session id. The fixed prefix is sufficient
// for short-lived flow correlation, never exposes the complete id, and avoids
// adding a node:crypto import solely for logging.

const SESSION_ID_RE = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION_PREFIX_LENGTH = 8;

export interface BrokerRequestLogFields {
  route: string;
  method: string;
  status: number;
  outcome: string;
  host: string;
  ua: string;
  sid: string | null;
  dur_ms: number;
}

interface RequestLogSource {
  method?: string;
  headers?: {
    host?: string | string[];
    'user-agent'?: string | string[];
  };
}

export function redactQuery(value: string): string;
export function redactQuery(value: unknown): unknown;
export function redactQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const queryIndex = value.indexOf('?');
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

export function sessionCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) return null;
  return value.slice(0, SESSION_PREFIX_LENGTH);
}

export function requestLogContext(req: RequestLogSource): {
  method: string;
  host: string;
  ua: string;
} {
  return {
    method: req.method ?? '',
    host: firstHeader(req.headers?.host),
    ua: firstHeader(req.headers?.['user-agent']),
  };
}

export function logEvent(fields: BrokerRequestLogFields): void {
  console.log(JSON.stringify({ t: 'broker_request', ...fields }));
}

function firstHeader(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  return value?.[0] ?? '';
}
