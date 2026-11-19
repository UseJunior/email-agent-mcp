// POST /api/refresh   { refresh_token }
//
// Stateless relay. The CLI sends its locally-stored refresh_token; we
// add the server-held client_id + client_secret and forward to Google's
// token endpoint. Google's response (new access_token + expiry) goes
// straight back to the CLI. We never persist the refresh_token.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { refresh } from '../lib/google.js';
import { readJsonBody } from '../lib/http.js';
import { logEvent, requestLogContext } from '../lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const startedAt = Date.now();
  const request = requestLogContext(req);
  let didLog = false;
  const logOnce = (status: number, outcome: string): void => {
    if (didLog) return;
    didLog = true;
    logEvent({
      route: '/api/refresh',
      method: request.method,
      status,
      outcome,
      host: request.host,
      ua: request.ua,
      sid: null,
      dur_ms: Date.now() - startedAt,
    });
  };

  try {
    if (req.method !== 'POST') {
      logOnce(405, 'method_not_allowed');
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');

    const body = readJsonBody(req);
    const token = body && typeof body['refresh_token'] === 'string' ? (body['refresh_token'] as string) : '';
    if (!token) {
      logOnce(400, 'refresh_failed');
      res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
      return;
    }

    try {
      const tokens = await refresh(token);
      logOnce(200, 'refreshed');
      res.status(200).json({
        access_token: tokens.access_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        token_type: tokens.token_type,
        // Google occasionally rotates the refresh token; pass through if so.
        refresh_token: tokens.refresh_token,
      });
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      const status = e.status && e.status >= 400 && e.status < 500 ? 400 : 502;
      logOnce(status, 'refresh_failed');
      const reauth = e.code === 'invalid_grant' || e.code === 'invalid_rapt';
      res.status(status).json({ error: reauth ? 'invalid_grant' : 'refresh_failed', error_description: reauth ? 'Authentication expired or revoked. Re-run configure.' : 'Authentication refresh failed. Re-run configure if the problem persists.' });
    }
  } catch {
    logOnce(500, 'internal_error');
    res.status(500).json({ error: 'internal_error', message: 'Authentication service unavailable. Retry later.' });
  }
}
