// POST /api/sessions
//   body: { session_id, pickup_hash, login_hint? }
//
// Registers a brand-new OAuth session before the user is sent to Google.
// `session_id` is a public correlation handle that ends up in URLs and
// state parameters. `pickup_hash` is SHA-256(pickup_secret) — the secret
// itself NEVER traverses the network or any URL. The CLI later proves
// ownership at /api/tickets/claim by presenting the raw secret, which we
// hash and compare in constant time.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStore } from '../lib/store.js';
import { readJsonBody, ID_RE, HEX64_RE } from '../lib/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');

  const body = readJsonBody(req);
  if (!body) {
    res.status(400).json({ error: 'invalid_request', message: 'JSON body required' });
    return;
  }

  const sessionId = typeof body['session_id'] === 'string' ? body['session_id'] : '';
  const pickupHash = typeof body['pickup_hash'] === 'string' ? body['pickup_hash'] : '';
  const loginHint = typeof body['login_hint'] === 'string' ? body['login_hint'] : undefined;

  if (!ID_RE.test(sessionId)) {
    res.status(400).json({ error: 'invalid_session_id', message: '32-128 char base64url required' });
    return;
  }
  if (!HEX64_RE.test(pickupHash)) {
    res.status(400).json({ error: 'invalid_pickup_hash', message: '64-char hex SHA-256 required' });
    return;
  }

  const result = await getStore().create(sessionId, {
    state: 'pending',
    pickupHash,
    loginHint,
    createdAt: Date.now(),
  });

  if (!result.created) {
    res.status(409).json({ error: 'session_exists' });
    return;
  }
  res.status(201).json({ status: 'created' });
}
