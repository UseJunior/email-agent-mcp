// GET /api/callback?code=...&state=<session>
//
// Google's redirect lands here. We exchange the code for tokens (using
// the server-held client_secret), park them under the session ID, and
// show a friendly "return to your terminal" page. The CLI is polling
// /api/tickets/:session and will pick them up.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeCode } from '../lib/google.js';
import { getStore } from '../lib/store.js';

const SESSION_RE = /^[A-Za-z0-9_-]{32,128}$/;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const error = typeof req.query['error'] === 'string' ? req.query['error'] : undefined;
  if (error) {
    renderTerminalPage(res, 400, `Authentication cancelled or denied: ${error}`);
    return;
  }

  const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
  const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
  if (!code || !SESSION_RE.test(state)) {
    renderTerminalPage(res, 400, 'Invalid OAuth callback: missing code or malformed state.');
    return;
  }

  try {
    const tokens = await exchangeCode(code);
    await getStore().put(state, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      tokenType: tokens.token_type,
    });
    renderTerminalPage(res, 200, 'Authentication complete. You can return to your terminal.');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'token exchange failed';
    renderTerminalPage(res, 502, `Authentication failed: ${message}`);
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
