import { randomUUID } from 'node:crypto';

const OAUTH_CODES = new Set(['invalid_grant', 'invalid_rapt', 'invalid_client', 'invalid_request', 'unsupported_grant_type', 'invalid_scope', 'temporarily_unavailable', 'server_error', 'unauthorized_client', 'access_denied']);
export function safeOAuthCode(value: unknown): string {
  return typeof value === 'string' && OAUTH_CODES.has(value) ? value : 'oauth_error';
}

/** Only pass fixed internal text. Never attach upstream Error.message/cause. */
export function brokerFailure(message: string): Error {
  const id = randomUUID();
  console.error(JSON.stringify({ event: 'broker_failure', error_id: id, message }));
  return new Error(`${message} (error ${id})`);
}
