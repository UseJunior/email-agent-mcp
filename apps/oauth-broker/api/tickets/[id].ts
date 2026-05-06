// GET /api/tickets/:id
//
// CLI polls this endpoint with the session ID it generated locally. As
// long as Google hasn't redirected to /api/callback yet, we return 404.
// The first request after callback returns the tokens and atomically
// removes them from the store. Subsequent requests return 404.
//
// The session ID itself is the bearer credential for the tokens. It is
// generated client-side from a 256-bit CSPRNG and never logged.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStore } from '../../lib/store.js';

const SESSION_RE = /^[A-Za-z0-9_-]{32,128}$/;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const id = String(req.query['id'] ?? '');
  if (!SESSION_RE.test(id)) {
    res.status(400).json({ error: 'invalid_session' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  const ticket = await getStore().takeOnce(id);
  if (!ticket) {
    res.status(404).json({ status: 'pending' });
    return;
  }
  res.status(200).json({
    access_token: ticket.accessToken,
    refresh_token: ticket.refreshToken,
    expires_in: ticket.expiresIn,
    scope: ticket.scope,
    token_type: ticket.tokenType,
  });
}
