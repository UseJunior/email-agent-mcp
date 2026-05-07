// Direct calls to Google's OAuth token endpoint. We don't use googleapis
// here on purpose — keeps the broker dependency surface tiny and the
// request shape obvious.

import { getConfig } from './config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export function buildAuthUrl(state: string, loginHint?: string): string {
  const cfg = getConfig();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const cfg = getConfig();
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
}

export async function refresh(refreshToken: string): Promise<TokenResponse> {
  const cfg = getConfig();
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json()) as TokenResponse | { error: string; error_description?: string };
  if (!res.ok || 'error' in data) {
    const err = (data as { error: string; error_description?: string });
    const e = new Error(`Google token endpoint: ${err.error}${err.error_description ? `: ${err.error_description}` : ''}`);
    (e as Error & { status?: number }).status = res.status;
    throw e;
  }
  return data as TokenResponse;
}
