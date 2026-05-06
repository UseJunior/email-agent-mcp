// GET /api/start?session=<base64url-256bit>[&login_hint=<email>]
//
// Initiates the OAuth dance. The CLI generates the session ID locally
// (and treats it as a bearer for the eventual /tickets/:id pickup), then
// opens this URL in the browser. We forward the user to Google's consent
// screen with state=<session> so we can rebind on /api/callback.
//
// We do NOT generate the session here. Forcing the CLI to bring its own
// session ID means the broker never knows the ID before the CLI does —
// which keeps the /tickets pickup safe even if logs leak.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildAuthUrl } from '../lib/google.js';

const SESSION_RE = /^[A-Za-z0-9_-]{32,128}$/;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const session = String(req.query['session'] ?? '');
  if (!SESSION_RE.test(session)) {
    res.status(400).json({ error: 'invalid_session', message: 'session must be a 32-128 char base64url string' });
    return;
  }

  const loginHint = typeof req.query['login_hint'] === 'string' ? req.query['login_hint'] : undefined;

  const url = buildAuthUrl(session, loginHint);
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, url);
}
