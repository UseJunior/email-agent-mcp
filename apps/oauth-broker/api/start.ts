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
import { logEvent, requestLogContext, sessionCorrelationId } from '../lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const startedAt = Date.now();
  const request = requestLogContext(req);
  let sessionSource: unknown = null;
  let didLog = false;
  const logOnce = (status: number, outcome: string): void => {
    if (didLog) return;
    didLog = true;
    logEvent({
      route: '/api/start',
      method: request.method,
      status,
      outcome,
      host: request.host,
      ua: request.ua,
      sid: sessionCorrelationId(sessionSource),
      dur_ms: Date.now() - startedAt,
    });
  };

  try {
    if (req.method !== 'GET') {
      logOnce(405, 'method_not_allowed');
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');

    sessionSource = req.query['session'];
    const session = String(sessionSource ?? '');
    if (!ID_RE.test(session)) {
      logOnce(400, 'invalid_session');
      res.status(400).json({ error: 'invalid_session' });
      return;
    }

    const record = await getStore().get(session);
    if (!record) {
      logOnce(410, 'session_expired_or_unknown');
      res.status(410).json({ error: 'session_expired_or_unknown' });
      return;
    }
    if (record.state !== 'pending') {
      logOnce(410, 'session_already_advanced');
      res.status(410).json({ error: 'session_already_advanced', state: record.state });
      return;
    }

    const authUrl = buildAuthUrl(session, record.loginHint);
    logOnce(302, 'redirected');
    res.redirect(302, authUrl);
  } catch (err) {
    logOnce(500, 'internal_error');
    throw err;
  }
}
