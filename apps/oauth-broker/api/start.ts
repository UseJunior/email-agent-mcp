// GET /api/start?session=<session_id>
//
// Browser entry point. Looks up a previously-registered session and
// redirects to Google's consent screen with state=<session_id>.
//
// We do NOT take pickup_hash here — that lives only in the prior
// /api/sessions POST. Anything in this URL can leak to logs/history.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildAuthUrl } from '../lib/google.js';
import { getStore } from '../lib/store.js';
import { ID_RE } from '../lib/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');

  const session = String(req.query['session'] ?? '');
  if (!ID_RE.test(session)) {
    res.status(400).json({ error: 'invalid_session' });
    return;
  }

  const record = await getStore().get(session);
  if (!record) {
    res.status(410).json({ error: 'session_expired_or_unknown' });
    return;
  }
  if (record.state !== 'pending') {
    res.status(410).json({ error: 'session_already_advanced', state: record.state });
    return;
  }

  res.redirect(302, buildAuthUrl(session, record.loginHint));
}
