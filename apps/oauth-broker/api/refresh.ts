// POST /api/refresh   { refresh_token }
//
// Stateless relay. The CLI sends its locally-stored refresh_token; we
// add the server-held client_id + client_secret and forward to Google's
// token endpoint. Google's response (new access_token + expiry) goes
// straight back to the CLI. We never persist the refresh_token.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { refresh } from '../lib/google.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) as
    | { refresh_token?: unknown }
    | null;

  const token = body && typeof body.refresh_token === 'string' ? body.refresh_token : '';
  if (!token) {
    res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
    return;
  }

  try {
    const tokens = await refresh(token);
    res.status(200).json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      token_type: tokens.token_type,
      // Google occasionally rotates the refresh token; pass through if so.
      refresh_token: tokens.refresh_token,
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    const status = e.status && e.status >= 400 && e.status < 500 ? 400 : 502;
    res.status(status).json({ error: 'refresh_failed', error_description: e.message });
  }
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
