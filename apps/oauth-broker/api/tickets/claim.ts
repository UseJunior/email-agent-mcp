// POST /api/tickets/claim
//   body: { session_id, pickup_secret }
//
// One-shot ticket claim. The CLI proves ownership by presenting the raw
// pickup_secret it generated locally; the broker hashes and compares
// against the SHA-256 hash registered at /api/sessions. Successful
// claim atomically deletes the session record (Redis GETDEL on KV,
// single-threaded delete on memory) so a second concurrent claim with
// the same secret returns 410 consumed.
//
// Response status semantics:
//   200 + tokens          -> ready, claimed
//   202 + status:'pending'-> consent flow not finished yet, keep polling
//   403 invalid_secret    -> hash mismatch (do NOT consume the session)
//   410 + status          -> denied | exchange_failed | expired | consumed
//   404 not_found         -> session id was never registered

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStore } from '../../lib/store.js';
import { readJsonBody, ID_RE } from '../../lib/http.js';
import { logEvent, requestLogContext, sessionCorrelationId } from '../../lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const startedAt = Date.now();
  const request = requestLogContext(req);
  let sessionSource: unknown = null;
  let didLog = false;
  const logOnce = (status: number, outcome: string): void => {
    if (didLog) return;
    didLog = true;
    logEvent({
      route: '/api/tickets/claim',
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
    if (req.method !== 'POST') {
      logOnce(405, 'method_not_allowed');
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');

    const body = readJsonBody(req);
    if (!body) {
      logOnce(400, 'invalid_request');
      res.status(400).json({ error: 'invalid_request', message: 'JSON body required' });
      return;
    }
    sessionSource = body['session_id'];
    const sessionId = typeof sessionSource === 'string' ? sessionSource : '';
    const pickupSecret = typeof body['pickup_secret'] === 'string' ? body['pickup_secret'] : '';

    if (!ID_RE.test(sessionId)) {
      logOnce(400, 'invalid_session_id');
      res.status(400).json({ error: 'invalid_session_id' });
      return;
    }
    if (!ID_RE.test(pickupSecret)) {
      logOnce(400, 'invalid_pickup_secret');
      res.status(400).json({ error: 'invalid_pickup_secret' });
      return;
    }

    const result = await getStore().claim(sessionId, pickupSecret);
    if (result.ok) {
      logOnce(200, 'claimed');
      res.status(200).json({
        access_token: result.tokens.access_token,
        refresh_token: result.tokens.refresh_token,
        expires_in: result.tokens.expires_in,
        scope: result.tokens.scope,
        token_type: result.tokens.token_type,
      });
      return;
    }

    switch (result.reason) {
      case 'pending':
        logOnce(202, 'pending');
        res.status(202).json({ status: 'pending' });
        return;
      case 'invalid_secret':
        logOnce(403, 'invalid_pickup_secret');
        res.status(403).json({ error: 'invalid_pickup_secret' });
        return;
      case 'not_found':
        logOnce(404, 'not_found');
        res.status(404).json({ status: 'not_found' });
        return;
      case 'expired':
      case 'consumed':
      case 'denied':
      case 'exchange_failed':
        logOnce(410, result.reason);
        res.status(410).json({ status: result.reason, ...(result.errorMessage ? { error_description: result.errorMessage } : {}) });
        return;
    }
  } catch (err) {
    logOnce(500, 'internal_error');
    throw err;
  }
}
