// GET /api/callback?code=...&state=<session_id>
//   or  /api/callback?error=access_denied&state=<session_id>
//
// Google's redirect target. Exchanges the code for tokens (using the
// server-held client_secret), advances the session to 'ready', then
// renders a friendly "return to your terminal" page. The CLI is
// polling /api/tickets/claim.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeCode } from '../lib/google.js';
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
      route: '/api/callback',
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

    sessionSource = req.query['state'];
    const state = typeof sessionSource === 'string' ? sessionSource : '';
    const error = typeof req.query['error'] === 'string' ? req.query['error'] : undefined;
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';

    if (!ID_RE.test(state)) {
      logOnce(400, 'invalid_state');
      renderTerminalPage(res, 400, 'Invalid OAuth callback: malformed state.');
      return;
    }

    // Mark the session terminally failed for explicit user-facing reasons
    // — this is what gives the CLI a distinguishable signal beyond "still
    // pending".
    if (error) {
      await getStore().setFailed(state, 'denied', `User cancelled or denied: ${error}`);
      logOnce(400, 'denied');
      renderTerminalPage(res, 400, `Authentication cancelled or denied: ${error}`);
      return;
    }

    if (!code) {
      await getStore().setFailed(state, 'exchange_failed', 'Google callback did not include a code.');
      logOnce(400, 'exchange_failed');
      renderTerminalPage(res, 400, 'Invalid OAuth callback: missing code.');
      return;
    }

    try {
      const tokens = await exchangeCode(code);
      const advanced = await getStore().setReady(state, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        token_type: tokens.token_type,
      });
      if (!advanced) {
        // Session was missing, expired, or already advanced — nothing the
        // user can do at this point.
        logOnce(410, 'invalid_state');
        renderTerminalPage(res, 410, 'This authentication session has expired. Re-run configure.');
        return;
      }
      logOnce(200, 'ready');
      renderTerminalPage(res, 200, 'Authentication complete. You can return to your terminal.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'token exchange failed';
      await getStore().setFailed(state, 'exchange_failed', message);
      logOnce(502, 'exchange_failed');
      renderTerminalPage(res, 502, `Authentication failed: ${message}`);
    }
  } catch (err) {
    logOnce(500, 'internal_error');
    throw err;
  }
}

function renderTerminalPage(res: VercelResponse, status: number, message: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const safe = message.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!));
  res.send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>email-agent-mcp — Gmail authentication</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1.5rem; color: #1f2937; }
  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
  .ok { color: #047857; }
  .err { color: #b91c1c; }
  code { background: #f3f4f6; padding: 0.125rem 0.375rem; border-radius: 0.25rem; }
</style>
<h1 class="${status === 200 ? 'ok' : 'err'}">${status === 200 ? '✓' : '✗'} email-agent-mcp</h1>
<p>${safe}</p>
<p style="color:#6b7280;font-size:0.875rem">This page can be closed.</p>`);
}
